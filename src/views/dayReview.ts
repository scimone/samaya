import { setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { Task, onDay, readTicket } from "../model";
import { projectPathOf } from "../projects";
import { dayPieces } from "../sessions";
import { Change, Grouping, ReviewItem, Row, Span, dayTotals, daySplit, when, groupRows, hasGroups, hourRange, runSpansOn, signed, taskRows, verdict } from "../dayreview";
import { breakMinutes, capacityWindow, workedOn } from "../worktime";
import { bufferShare, loadLevel } from "../weekplan";
import { fmtDur, hmToMin, minToHm } from "../util";
import { nowMin } from "../workday";

/** A meeting of the day, in minutes of the day. */
export interface ReviewEvent { title: string; s: number; e: number; }

/** Everything the review needs. The baseline is the plan saved when the day was first planned (tasks, lengths, time slots); without one, today's list as it is now (`hasPlan` false). */
export function reviewItems(plugin: SamayaPlugin, all: Task[], date: string): { items: ReviewItem[]; hasPlan: boolean } {
  const app = plugin.app; const snap = plugin.data.dayPlans?.[date]; const hasPlan = !!snap;
  const now = new Map(onDay(all, date).map(t => [t.file.path, t]));
  const base = new Map<string, { est: number; slots: Span[] }>(snap
    ? snap.map(x => [x.path, { est: x.est, slots: (x.slots ?? []).map(([s, d]): Span => ({ s, e: s + d })) }])
    : [...now].map(([p, t]) => [p, { est: t.estimate, slots: dayPieces(t.sessions, date).filter(g => g.s !== null).map((g): Span => ({ s: g.s!, e: g.s! + g.dur })) }]));
  const items: ReviewItem[] = [];
  for (const t of all) {
    const fm = (app.metadataCache.getFileCache(t.file)?.frontmatter ?? {}) as Record<string, unknown>;
    const runs = Array.isArray(fm.focus_sessions) ? fm.focus_sessions : fm.focus_sessions ? [fm.focus_sessions] : [];
    const spans = runSpansOn(runs, date); const actual = spans.reduce((a, g) => a + (g.e - g.s), 0); const plan = base.get(t.file.path);
    const doneToday = t.status === "done" && String(fm.day_completed ?? "").slice(0, 10) === date; // ticked off today, even if never planned or timed
    if (!plan && !actual && !doneToday) continue;
    const tf = t.ticket ? app.metadataCache.getFirstLinkpathDest(t.ticket, t.file.path) : null;
    const pp = plugin.settings.projectsOn ? projectPathOf(app, t.file) : "";
    items.push({ key: t.file.path, title: t.title, wasPlanned: !!plan || !hasPlan, planned: plan?.est ?? 0, actual, done: t.status === "done", slots: plan?.slots ?? [], spans,
      ticket: tf ? readTicket(app, tf).key : "", project: pp ? pp.split("/").pop()!.replace(/\.md$/, "") : "" });
  }
  return { items, hasPlan };
}

/** The charts grow in once; the planner re-renders often, and a re-render soon after the last one shows the final state at once. */
let lastShown = 0; let anim = true;
const settle = (fn: () => void) => { if (anim) requestAnimationFrame(() => requestAnimationFrame(fn)); else fn(); };

const ICON_OK = "check", ICON_UP = "trending-up", ICON_DOWN = "trending-down";
const CHANGE: Record<Change, { label: string; cls: string }> = {
  added: { label: "Unplanned", cls: "is-added" }, skipped: { label: "Not worked", cls: "is-skipped" }, open: { label: "Not finished", cls: "is-open" },
  over: { label: "Over", cls: "is-over" }, under: { label: "Under", cls: "is-under" }, moved: { label: "Moved", cls: "is-moved" },
};

/** Second step of "End my day": the planned day set against the day as it really went - a timeline of both, what changed task by task, and what was achieved per ticket / project. */
export function renderDayReview(plugin: SamayaPlugin, host: HTMLElement, o: { date: string; all: Task[]; meetings: number; events: ReviewEvent[] }) {
  anim = Date.now() - lastShown > 4000; lastShown = Date.now();
  const grid = host.createDiv("samaya-rv"); const info = grid.createDiv("samaya-rv-col is-info"); const tl = grid.createDiv("samaya-rv-col is-tl"); const { items, hasPlan } = reviewItems(plugin, o.all, o.date);
  const now = nowMin(); const log = plugin.workday.log; const [winFrom, winTo] = plugin.workWindowFor(o.date); const lunch = plugin.lunchFor(o.date);
  const worked = workedOn(log, now, plugin.dayRules); const breaks = log ? breakMinutes(log) + (log.open ? Math.max(0, now - hmToMin(log.open.start)) : 0) : 0;
  const { plannedItems, added, planned, comparableActual, focus, done, addedDone } = dayTotals(items, hasPlan);
  const sp = daySplit(worked, focus, o.meetings, breaks);
  const startAt = log?.start ? hmToMin(log.start) : null; const endAt = log?.start ? (log.end ? hmToMin(log.end) : now) : null;

  // ---- right: the two days side by side on one time axis
  const rows = taskRows(items);
  const share = bufferShare(plugin.settings.bufferPercent); const cap = capacityWindow(winFrom, winTo, lunch, o.events.map((e): [number, number] => [e.s, e.e]));
  const bufferMin = Math.round(cap.free * (1 - share)); const planTasks = Math.min(planned, Math.max(0, cap.total - cap.lunch - cap.meetings)); const level = loadLevel(planned, cap.free, share);
  const scale = Math.max(cap.total - cap.lunch, sp.meetings + sp.focus + sp.other, 1); // both bars on one scale: the plannable day, or the worked time when that is more
  const capPlan: CapSeg[] = [{ cls: "is-meet", m: cap.meetings, tip: `Meetings: ${fmtDur(cap.meetings)}` }, { cls: `is-task is-${level}`, m: planTasks, tip: `Planned tasks: ${fmtDur(planned)}${level === "ok" ? "" : level === "tight" ? " (into the buffer)" : " (more than there is time for)"}` }];
  const capAct: CapSeg[] = [{ cls: "is-meet", m: sp.meetings, tip: `Meetings: ${fmtDur(sp.meetings)}` }, { cls: "is-task", m: sp.focus, tip: `Focused on tasks: ${fmtDur(sp.focus)}` }, { cls: "is-other", m: sp.other, tip: `Other work: ${fmtDur(sp.other)}` }];
  const capIn = { scale, buffer: bufferMin > 0 ? [cap.total - cap.lunch - bufferMin, cap.total - cap.lunch] as [number, number] : null, bufferTip: `Buffer: ${fmtDur(bufferMin)} kept free for the unforeseen`, plan: capPlan, act: capAct };
  tl.createDiv({ cls: "samaya-rv-h", text: "Plan vs. reality" });
  drawTimeline(tl, { items, events: o.events, window: [winFrom, winTo], lunch, start: startAt, end: endAt, breaks: (log?.breaks ?? []).map((b): [number, number] => [hmToMin(b.start), hmToMin(b.end)]), hasPlan, linkRoot: grid, room: host.clientHeight, cap: capIn });
  const untimed = hasPlan ? plannedItems.filter(i => !i.slots.length).length : 0;
  if (untimed) tl.createDiv({ cls: "samaya-rv-note", text: `${untimed} planned ${untimed === 1 ? "task" : "tasks"} had no time slot, so ${untimed === 1 ? "it is" : "they are"} not on the planned timeline.` });
  if (!hasPlan) tl.createDiv({ cls: "samaya-rv-note", text: "No plan was saved when this day was planned, so today's list is used as the plan." });

  // ---- left: headline, the day in four numbers, how the time was spent
  const v = verdict(planned, comparableActual, done, plannedItems.length);
  const head = info.createDiv("samaya-rv-head");
  head.createDiv({ cls: "samaya-rv-vtitle", text: v.title });
  head.createDiv({ cls: "samaya-rv-vtext", text: v.text + (addedDone ? ` Plus ${addedDone} ${addedDone === 1 ? "task" : "tasks"} you added along the way.` : "") });
  const stats = info.createDiv("samaya-rv-stats");
  const stat = (label: string, value: string, plan: string, delta: string, tone = "") => {
    const t = stats.createDiv("samaya-rv-stat"); t.createDiv({ cls: "samaya-rv-stat-l", text: label }); t.createDiv({ cls: "samaya-rv-stat-v", text: value });
    const s = t.createDiv("samaya-rv-stat-s"); if (plan) s.createSpan({ text: plan }); if (delta) s.createSpan({ cls: `samaya-rv-stat-d ${tone}`, text: delta });
  };
  const gap = (d: number) => (Math.abs(d) < 1 ? "on time" : signed(d, fmtDur));
  stat("Start", startAt !== null ? minToHm(startAt) : "–", `plan ${minToHm(winFrom)}`, startAt !== null ? gap(startAt - winFrom) : "", startAt !== null && startAt - winFrom > 0 ? "is-warn" : "");
  stat("Finish", endAt !== null ? minToHm(endAt) : "–", `plan ${minToHm(winTo)}`, endAt !== null ? gap(endAt - winTo) : "", endAt !== null && endAt - winTo > 0 ? "is-warn" : "");
  stat("Tasks done", `${done + addedDone}/${plannedItems.length}`, "", added.length ? `(${added.length} unplanned)` : "", "is-added");
  stat("Time on tasks", fmtDur(focus), planned ? `plan ${fmtDur(planned)}` : "", planned ? signed(focus - planned, fmtDur) : "", focus > planned ? "is-warn" : "is-ok");

  // ---- what changed, task by task: takes the height that is left and scrolls when it is too long
  const diff = rows.filter(r => r.changes.length); const same = rows.filter(r => !r.changes.length);
  const sec = info.createDiv("samaya-rv-sec is-grow");
  const h = sec.createDiv({ cls: "samaya-rv-h samaya-rv-h-row" }); h.createSpan({ text: "What changed" });
  if (rows.length) h.createSpan({ cls: "samaya-rv-row-tag", text: diff.length ? `${diff.length} of ${rows.length} differ from the plan` : "Everything went as planned" });
  if (!rows.length) sec.createDiv({ cls: "samaya-empty", text: "Nothing was planned or done today." });
  else {
    const table = sec.createDiv("samaya-rv-table samaya-rv-scroll");
    const hd = table.createDiv("samaya-rv-r is-head"); hd.createSpan(); hd.createSpan({ text: "Task" }); hd.createSpan({ cls: "samaya-rv-c", text: "Planned" }); hd.createSpan({ cls: "samaya-rv-c", text: "Actual" }); hd.createSpan();
    for (const r of diff) drawRow(table, r, grid);
    if (diff.length && same.length) table.createDiv({ cls: "samaya-rv-sep", text: "As planned" });
    for (const r of same) drawRow(table, r, grid);
  }

  // ---- time per ticket and per project, when those are in use
  drawRings(info, items);
}

/** One task of the comparison table: its planned and actual start and length, what differs as chips, the gap in tracked time. */
function drawRow(table: HTMLElement, r: Row, root: HTMLElement) {
  const row = table.createDiv("samaya-rv-r" + (r.changes.length ? " has-change" : "")); row.dataset.k = r.key; linkHover(row, root, r.key);
  const ic = row.createSpan("samaya-rv-row-ic" + (r.done ? " is-done" : "")); if (r.done) { setIcon(ic, ICON_OK); ic.setAttr("aria-label", "Done"); }
  const name = row.createDiv("samaya-rv-r-name"); name.createSpan({ cls: "samaya-rv-row-name", text: r.label, attr: { "aria-label": r.label } });
  for (const c of r.changes) name.createSpan({ cls: `samaya-rv-chip ${CHANGE[c].cls}`, text: CHANGE[c].label });
  row.createSpan({ cls: "samaya-rv-c samaya-rv-r-plan", text: r.unplanned ? "–" : when(r.plannedAt, r.planned) });
  row.createSpan({ cls: "samaya-rv-c samaya-rv-r-act", text: r.actual ? fmtDur(r.actual) : r.done ? "checked off" : "–" });
  const d = r.planned && r.actual ? r.actual - r.planned : 0; const dl = row.createSpan("samaya-rv-delta" + (d >= 5 ? " is-over" : d <= -5 ? " is-under" : ""));
  if (Math.abs(d) >= 5) { setIcon(dl.createSpan(), d > 0 ? ICON_UP : ICON_DOWN); dl.createSpan({ text: fmtDur(Math.abs(d)) }); }
}

/** Hovering a task anywhere (timeline block or table row) lights up the same task everywhere else. */
function linkHover(el: HTMLElement, root: HTMLElement, key: string) {
  el.addEventListener("mouseenter", () => { root.addClass("is-linking"); root.querySelectorAll<HTMLElement>("[data-k]").forEach(x => x.toggleClass("is-linked", x.dataset.k === key)); });
  el.addEventListener("mouseleave", () => { root.removeClass("is-linking"); root.querySelectorAll(".is-linked").forEach(x => x.removeClass("is-linked")); });
}

interface TimelineIn { items: ReviewItem[]; events: ReviewEvent[]; window: [number, number]; lunch: [number, number]; start: number | null; end: number | null; breaks: Array<[number, number]>; hasPlan: boolean; linkRoot: HTMLElement; cap: CapIn; /** height of the pane: the hours stretch to fill it */ room: number; }
const MIN_HOUR_PX = 20, MAX_HOUR_PX = 160, CHROME_PX = 240; // CHROME_PX: padding, headings, column titles and legend around the lanes
/** Two lanes on one time axis: the plan as dashed outlines, the day as filled blocks. What was never worked is a faded outline, what nobody planned wears the accent colour. */
function drawTimeline(host: HTMLElement, t: TimelineIn) {
  const spans = t.items.flatMap(i => [...i.slots, ...i.spans]);
  const [h0, h1] = hourRange([t.window[0], t.window[1], ...spans.flatMap(g => [g.s, g.e]), ...t.events.flatMap(e => [e.s, e.e]), ...(t.start !== null ? [t.start] : []), ...(t.end !== null ? [t.end] : [])]);
  const HOUR_PX = Math.max(MIN_HOUR_PX, Math.min(MAX_HOUR_PX, Math.floor((t.room - CHROME_PX) / (h1 - h0))));
  const px = (m: number) => ((Math.min(h1 * 60, Math.max(h0 * 60, m)) - h0 * 60) / 60) * HOUR_PX; const height = (h1 - h0) * HOUR_PX;
  const box = host.createDiv("samaya-rv-tl");
  const head = box.createDiv("samaya-rv-tl-head"); head.createSpan();
  head.createDiv("samaya-rv-tl-col").createSpan({ text: "Planned" }); drawCap(head.lastElementChild as HTMLElement, t.cap.plan, t.cap);
  head.createDiv("samaya-rv-tl-col").createSpan({ text: "Actual" }); drawCap(head.lastElementChild as HTMLElement, t.cap.act, t.cap);
  const body = box.createDiv("samaya-rv-tl-body"); body.style.height = `${height}px`;
  const axis = body.createDiv("samaya-rv-axis");
  for (let h = h0; h < h1; h++) axis.createSpan({ cls: "samaya-rv-hour", text: minToHm(h * 60) }).style.top = `${(h - h0) * HOUR_PX}px`;
  const lane = (cls: string) => { const l = body.createDiv(`samaya-rv-lane ${cls}`); l.style.backgroundSize = `100% ${HOUR_PX}px`; return l; };
  const band = (l: HTMLElement, cls: string, a: number, b: number) => { if (b <= a) return; const d = l.createDiv(`samaya-rv-band ${cls}`); d.style.top = `${px(a)}px`; d.style.height = `${Math.max(0, px(b) - px(a))}px`; return d; };
  const edge = (l: HTMLElement, a: number, b: number) => { // the lane's first and last minute, as times
    l.createDiv({ cls: "samaya-rv-edge is-top", text: minToHm(a) }).style.top = `${px(a)}px`;
    l.createDiv({ cls: "samaya-rv-edge is-bottom", text: minToHm(b) }).style.top = `${px(b)}px`;
  };
  const block = (l: HTMLElement, cls: string, a: number, b: number, text: string, time: string, tip: string, key?: string) => {
    const d = l.createDiv(`samaya-rv-blk ${cls}`); d.style.top = `${px(a)}px`; d.style.height = `${Math.max(14, px(b) - px(a) - 1)}px`; d.setAttr("aria-label", tip);
    d.createSpan({ cls: "samaya-rv-blk-t", text }); d.createSpan({ cls: "samaya-rv-blk-m", text: time });
    if (key) { d.dataset.k = key; linkHover(d, t.linkRoot, key); }
    return d;
  };
  const meetings = (l: HTMLElement) => t.events.forEach(e => block(l, "is-meeting", e.s, e.e, e.title, `${minToHm(e.s)}–${minToHm(e.e)}`, `${e.title} · ${minToHm(e.s)}–${minToHm(e.e)}`));
  const range = (g: Span) => `${minToHm(g.s)}–${minToHm(g.e)}`;

  // planned
  const pl = lane("is-plan"); band(pl, "is-window", t.window[0], t.window[1]); band(pl, "is-lunch", t.lunch[0], t.lunch[1]); edge(pl, t.window[0], t.window[1]); meetings(pl);
  for (const i of t.items) if (i.wasPlanned) for (const g of i.slots) {
    const skipped = !i.actual && !i.done;
    block(pl, "is-ghost" + (skipped ? " is-skipped" : ""), g.s, g.e, i.title, range(g), `${i.title} · planned ${range(g)}${skipped ? " · not worked" : ""}`, i.key);
  }
  if (t.hasPlan && !t.items.some(i => i.wasPlanned && i.slots.length)) pl.createDiv({ cls: "samaya-rv-lane-empty", text: "No times were planned" });
  // actual
  const ac = lane("is-act");
  if (t.start !== null && t.end !== null) { band(ac, "is-window", t.start, t.end); edge(ac, t.start, t.end); }
  for (const [a, b] of t.breaks) band(ac, "is-lunch", a, b);
  meetings(ac);
  for (const i of t.items) for (const g of i.spans) {
    const added = !i.wasPlanned;
    const d = block(ac, "is-fill" + (added ? " is-added" : "") + (i.done ? " is-done" : ""), g.s, g.e, i.title, range(g), `${i.title} · ${range(g)} · ${fmtDur(g.e - g.s)}${added ? " · unplanned" : ""}${i.done ? " · done" : ""}`, i.key);
    if (i.done && g === i.spans[i.spans.length - 1]) setIcon(d.createSpan("samaya-rv-blk-ok"), ICON_OK);
  }
  if (!t.items.some(i => i.spans.length)) ac.createDiv({ cls: "samaya-rv-lane-empty", text: "No focus time tracked" });

  const key = box.createDiv("samaya-rv-legend");
  for (const [cls, name] of [["is-ghost", "Planned"], ["is-fill", "Tracked"], ["is-added", "Unplanned"], ["is-skipped", "Not worked"], ["is-meeting", "Meeting"]]) { const l = key.createSpan("samaya-rv-legend-item"); l.createSpan({ cls: `samaya-rv-key ${cls}` }); l.createSpan({ text: name }); }
}

interface CapSeg { cls: string; m: number; tip: string; }
interface CapIn { scale: number; buffer: [number, number] | null; bufferTip: string; plan: CapSeg[]; act: CapSeg[]; }
/** A day's capacity as one bar: meetings, then tasks, then other work, on `scale` minutes. The hatched stretch is the buffer, the end of the plannable time kept free for what nobody can foresee. The details are in tooltips. */
function drawCap(host: HTMLElement, segs: CapSeg[], c: CapIn) {
  const bar = host.createDiv("samaya-rv-cap"); const fills: Array<[HTMLElement, number]> = [];
  if (c.buffer) { const b = bar.createDiv("samaya-rv-cap-buffer"); b.style.left = `${(c.buffer[0] / c.scale) * 100}%`; b.style.width = `${((c.buffer[1] - c.buffer[0]) / c.scale) * 100}%`; b.setAttr("aria-label", c.bufferTip); }
  const row = bar.createDiv("samaya-rv-cap-segs");
  for (const g of segs) if (g.m > 0) { const e = row.createDiv(`samaya-rv-cap-seg ${g.cls}`); e.style.width = "0%"; e.setAttr("aria-label", g.tip); fills.push([e, (g.m / c.scale) * 100]); }
  settle(() => fills.forEach(([e, w]) => { e.style.width = `${w}%`; }));
}

/** Hue for the n-th ticket / project; the "none" group is grey. */
const hueOf = (n: number) => `hsl(${(n * 137.5 + 150) % 360} 48% 58%)`;
const RING_R = 38, RING_C = 2 * Math.PI * RING_R;
/** One ring per grouping in use (tickets, projects): how the tracked time divides up, with the biggest first in a list beside it. */
function drawRings(host: HTMLElement, items: ReviewItem[]) {
  const kinds = (["ticket", "project"] as Grouping[]).map(by => ({ by, groups: hasGroups(items, by) ? groupRows(items, by).filter(g => g.actual > 0) : [] })).filter(k => k.groups.length);
  if (!kinds.length) return;
  const wrap = host.createDiv("samaya-rv-rings");
  for (const { by, groups } of kinds) {
    const none = by === "ticket" ? "No ticket" : "No project";
    const sorted = [...groups].sort((a, b) => Number(a.label === none) - Number(b.label === none) || b.actual - a.actual);
    const total = sorted.reduce((a, g) => a + g.actual, 0); const colour = (label: string, n: number) => (label === none ? "var(--rv-other)" : hueOf(n));
    const card = wrap.createDiv("samaya-rv-ringcard"); card.createDiv({ cls: "samaya-rv-h", text: by === "ticket" ? "Time per ticket" : "Time per project" });
    const body = card.createDiv("samaya-rv-ringbody"); const box = body.createDiv("samaya-rv-ring");
    const svg = box.createSvg("svg", { attr: { viewBox: "0 0 100 100", role: "img", "aria-label": `Time per ${by}` } });
    svg.createSvg("circle", { attr: { class: "samaya-rv-ring-bg", cx: "50", cy: "50", r: String(RING_R) } });
    const gapLen = sorted.length > 1 ? 1.6 : 0; let at = 0; const arcs: Array<[SVGElement, number, number]> = [];
    sorted.forEach((g, n) => {
      const len = (g.actual / total) * RING_C; const c = svg.createSvg("circle", { attr: { class: "samaya-rv-ring-seg", cx: "50", cy: "50", r: String(RING_R), transform: "rotate(-90 50 50)", "stroke-dasharray": `0 ${RING_C}`, "stroke-dashoffset": String(-at) } });
      c.style.stroke = colour(g.label, n); c.setAttribute("aria-label", `${g.label}: ${fmtDur(g.actual)}`); arcs.push([c, Math.max(0.5, len - gapLen), len]); at += len;
    });
    settle(() => arcs.forEach(([c, shown]) => c.setAttribute("stroke-dasharray", `${shown} ${RING_C - shown}`)));
    const mid = box.createDiv("samaya-rv-ring-mid"); mid.createSpan({ cls: "samaya-rv-ring-n", text: fmtDur(total) });
    const list = body.createDiv("samaya-rv-glist samaya-rv-scroll");
    sorted.forEach((g, n) => {
      const row = list.createDiv("samaya-rv-g"); row.createSpan("samaya-rv-dot").style.background = colour(g.label, n);
      row.createSpan({ cls: "samaya-rv-row-name", text: g.label, attr: { "aria-label": g.label } });
      row.createSpan({ cls: "samaya-rv-row-act", text: fmtDur(g.actual) }); row.createSpan({ cls: "samaya-rv-g-pct", text: `${Math.round((g.actual / total) * 100)}%` });
    });
  }
}
