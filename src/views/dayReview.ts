import { setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { Task, onDay, readTicket } from "../model";
import { projectPathOf } from "../projects";
import { dayPieces } from "../sessions";
import { Change, Grouping, ReviewItem, Row, Span, dayTotals, daySplit, when, groupRows, hasGroups, hourRange, runSpansOn, signed, taskRows, verdict } from "../dayreview";
import { breakMinutes, workedOn } from "../worktime";
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
  tl.createDiv({ cls: "samaya-rv-h", text: "Plan vs. reality" });
  drawTimeline(tl, { items, events: o.events, window: [winFrom, winTo], lunch, start: startAt, end: endAt, breaks: (log?.breaks ?? []).map((b): [number, number] => [hmToMin(b.start), hmToMin(b.end)]), hasPlan, linkRoot: grid, room: host.clientHeight });
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

  if (sp.total > 0) {
    const bar = info.createDiv("samaya-rv-split");
    const parts: Array<[string, string, number]> = [["is-focus", "Focused on tasks", sp.focus], ["is-meet", "Meetings", sp.meetings], ["is-other", "Other work", sp.other], ["is-break", "Breaks", sp.breaks]];
    const segs = parts.filter(p => p[2] > 0).map(([cls, name, m]) => { const s = bar.createDiv(`samaya-rv-seg ${cls}`); s.setAttr("aria-label", `${name}: ${fmtDur(m)}`); s.style.width = "0%"; return [s, m] as const; });
    settle(() => segs.forEach(([s, m]) => { s.style.width = `${(m / sp.total) * 100}%`; }));
    const legend = info.createDiv("samaya-rv-legend");
    for (const [cls, name, m] of parts) if (m > 0) { const l = legend.createSpan("samaya-rv-legend-item"); l.createSpan({ cls: `samaya-rv-swatch ${cls}` }); l.createSpan({ text: `${name} ${fmtDur(m)}` }); }
    if (!focus && worked) info.createDiv({ cls: "samaya-rv-note", text: "Time on tasks comes from the focus timer. Start it on a task to see where the day goes." });
  }

  // ---- what changed, task by task
  const diff = rows.filter(r => r.changes.length); const same = rows.filter(r => !r.changes.length);
  const h = info.createDiv({ cls: "samaya-rv-h samaya-rv-h-row" }); h.createSpan({ text: "What changed" });
  if (rows.length) h.createSpan({ cls: "samaya-rv-row-tag", text: diff.length ? `${diff.length} of ${rows.length} differ from the plan` : "Everything went as planned" });
  if (!rows.length) info.createDiv({ cls: "samaya-empty", text: "Nothing was planned or done today." });
  else {
    const table = info.createDiv("samaya-rv-table");
    const hd = table.createDiv("samaya-rv-r is-head"); hd.createSpan(); hd.createSpan({ text: "Task" }); hd.createSpan({ cls: "samaya-rv-c", text: "Planned" }); hd.createSpan({ cls: "samaya-rv-c", text: "Actual" }); hd.createSpan();
    for (const r of diff) drawRow(table, r, grid);
    if (diff.length && same.length) table.createDiv({ cls: "samaya-rv-sep", text: "As planned" });
    for (const r of same) drawRow(table, r, grid);
  }

  // ---- what was achieved per ticket and per project, when those are in use (both, one under the other)
  for (const by of ["ticket", "project"] as Grouping[]) if (hasGroups(items, by)) drawGroups(info, items, by);
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

interface TimelineIn { items: ReviewItem[]; events: ReviewEvent[]; window: [number, number]; lunch: [number, number]; start: number | null; end: number | null; breaks: Array<[number, number]>; hasPlan: boolean; linkRoot: HTMLElement; /** height of the pane: the hours stretch to fill it */ room: number; }
const MIN_HOUR_PX = 46, MAX_HOUR_PX = 160, CHROME_PX = 190; // CHROME_PX: padding, headings, column titles and legend around the lanes
/** Two lanes on one time axis: the plan as dashed outlines, the day as filled blocks. What was never worked is a faded outline, what nobody planned wears the accent colour. */
function drawTimeline(host: HTMLElement, t: TimelineIn) {
  const spans = t.items.flatMap(i => [...i.slots, ...i.spans]);
  const [h0, h1] = hourRange([t.window[0], t.window[1], ...spans.flatMap(g => [g.s, g.e]), ...t.events.flatMap(e => [e.s, e.e]), ...(t.start !== null ? [t.start] : []), ...(t.end !== null ? [t.end] : [])]);
  const HOUR_PX = Math.max(MIN_HOUR_PX, Math.min(MAX_HOUR_PX, Math.floor((t.room - CHROME_PX) / (h1 - h0))));
  const px = (m: number) => ((Math.min(h1 * 60, Math.max(h0 * 60, m)) - h0 * 60) / 60) * HOUR_PX; const height = (h1 - h0) * HOUR_PX;
  const box = host.createDiv("samaya-rv-tl");
  const head = box.createDiv("samaya-rv-tl-head"); head.createSpan(); head.createSpan({ text: "Planned" }); head.createSpan({ text: "Actual" });
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

/** Hue for the n-th ticket / project; the "none" group is grey. */
const hueOf = (n: number) => `hsl(${(n * 137.5 + 150) % 360} 48% 58%)`;
/** Time per ticket or project: the plan and the day as two stacked bars on one scale (same colours), and under them a row for each with what got done. */
function drawGroups(host: HTMLElement, items: ReviewItem[], by: Grouping) {
  const groups = groupRows(items, by); const none = by === "ticket" ? "No ticket" : "No project";
  const colour = (g: { label: string }, n: number) => (g.label === none ? "var(--rv-other)" : hueOf(n));
  const sec = host.createDiv("samaya-rv-sec"); const h = sec.createDiv({ cls: "samaya-rv-h samaya-rv-h-row" }); h.createSpan({ text: by === "ticket" ? "Achieved per ticket" : "Achieved per project" });
  const done = groups.reduce((a, g) => a + g.done, 0); const tasks = groups.reduce((a, g) => a + g.tasks, 0); h.createSpan({ cls: "samaya-rv-row-tag", text: `${done}/${tasks} tasks done` });
  const total = (k: "planned" | "actual") => groups.reduce((a, g) => a + g[k], 0); const max = Math.max(1, total("planned"), total("actual"));
  const bars = sec.createDiv("samaya-rv-stacks"); const fills: Array<[HTMLElement, number]> = [];
  for (const [k, name] of [["planned", "Plan"], ["actual", "Actual"]] as const) {
    const row = bars.createDiv("samaya-rv-stack-row"); row.createSpan({ cls: "samaya-rv-stack-l", text: name });
    const bar = row.createDiv("samaya-rv-stack"); let n = 0;
    for (const g of groups) { const m = g[k]; const c = colour(g, n++); if (m <= 0) continue; const seg = bar.createDiv("samaya-rv-stack-seg"); seg.style.background = c; seg.style.width = "0%"; seg.setAttr("aria-label", `${g.label}: ${fmtDur(m)} ${k === "planned" ? "planned" : "tracked"}`); fills.push([seg, (m / max) * 100]); }
    row.createSpan({ cls: "samaya-rv-stack-n", text: total(k) ? fmtDur(total(k)) : "–" });
  }
  settle(() => fills.forEach(([el, w]) => { el.style.width = `${w}%`; }));
  const list = sec.createDiv("samaya-rv-glist"); let n = 0;
  for (const g of groups) {
    const row = list.createDiv("samaya-rv-g"); row.createSpan("samaya-rv-dot").style.background = colour(g, n++);
    row.createSpan({ cls: "samaya-rv-row-name", text: g.label, attr: { "aria-label": g.label } });
    if (g.added) row.createSpan({ cls: "samaya-rv-chip is-added", text: `${g.added} unplanned` });
    row.createSpan({ cls: "samaya-rv-g-done", text: `${g.done}/${g.tasks} done` });
    const nums = row.createSpan("samaya-rv-row-nums"); nums.createSpan({ cls: "samaya-rv-row-act", text: g.actual ? fmtDur(g.actual) : "–" }); if (g.planned) nums.createSpan({ cls: "samaya-rv-row-plan", text: ` / ${fmtDur(g.planned)}` });
  }
}
