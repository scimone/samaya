import { App, TFile, setIcon } from "obsidian";
import { openFileSmart } from "../openfile";
import { meetingLinks } from "../links";
import { srName } from "./srname";
import type SamayaPlugin from "../main";
import { Task, onDay, readTicket } from "../model";
import { projectPathOf } from "../projects";
import { dayPieces } from "../sessions";
import { Grouping, MeetingLink, ReviewItem, Row, Span, dayTotals, daySplit, when, timeGroups, hasGroups, hourRange, runSpansOn, signed, taskRows, verdict } from "../dayreview";
import { breakMinutes, capacityWindow, workedOn } from "../worktime";
import { bufferShare, loadLevel } from "../weekplan";
import { fmtDur, hmToMin, minToHm } from "../util";
import { nowMin } from "../workday";

/** A meeting of the day, in minutes of the day. */
export interface ReviewEvent { title: string; s: number; e: number; /** the meeting's note, when it has one */ notePath?: string; }
/** The day's meetings with the tickets / projects their notes are assigned to. */
export function meetingLinksOf(plugin: SamayaPlugin, events: ReviewEvent[]): MeetingLink[] {
  const app = plugin.app; const base = (p: string) => p.split("/").pop()!.replace(/\.md$/, ""); const out: MeetingLink[] = [];
  for (const e of events) {
    const f = e.notePath ? app.vault.getAbstractFileByPath(e.notePath) : null;
    if (!(f instanceof TFile)) { out.push({ minutes: Math.max(0, e.e - e.s), tickets: [], projects: [] }); continue; } // a meeting without a note: unassigned
    const tickets = plugin.settings.ticketsOn ? meetingLinks(app, f, "assigned_ticket").map(p => app.vault.getAbstractFileByPath(p)).filter((x): x is TFile => x instanceof TFile).map(x => ({ label: readTicket(app, x).key || base(x.path), note: x.basename })) : [];
    const projects = plugin.settings.projectsOn ? meetingLinks(app, f, "assigned_project").map(base) : [];
    out.push({ minutes: Math.max(0, e.e - e.s), tickets, projects });
  }
  return out;
}

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
      ticket: tf ? readTicket(app, tf).key : "", ticketNote: tf ? tf.basename : "", project: pp ? pp.split("/").pop()!.replace(/\.md$/, "") : "" });
  }
  return { items, hasPlan };
}

/** The charts grow in once; the planner re-renders often, and a re-render soon after the last one shows the final state at once. */
let lastShown = 0; let anim = true;
const settle = (fn: () => void) => { if (anim) requestAnimationFrame(() => requestAnimationFrame(fn)); else fn(); };

/** Clicking a task, meeting, ticket or project of the review opens its note in the side pane. */
let appRef: App | null = null;
function setOpener(plugin: SamayaPlugin) { appRef = plugin.app; }
function clickable(el: Element, path: string) {
  el.classList.add("is-clickable");
  el.addEventListener("click", e => { e.stopPropagation(); const f = appRef?.vault.getAbstractFileByPath(path); if (appRef && f instanceof TFile) openFileSmart(appRef, f); });
}
const ICON_OK = "check", ICON_UP = "trending-up", ICON_DOWN = "trending-down";

/** Second step of "End my day": the planned day set against the day as it really went - a timeline of both, what changed task by task, and what was achieved per ticket / project. */
export function renderDayReview(plugin: SamayaPlugin, host: HTMLElement, o: { date: string; all: Task[]; meetings: number; events: ReviewEvent[] }) {
  anim = Date.now() - lastShown > 4000; lastShown = Date.now(); setOpener(plugin);
  const grid = host.createDiv("samaya-rv"); const info = grid.createDiv("samaya-rv-col is-info"); const tl = grid.createDiv("samaya-rv-col is-tl"); const { items, hasPlan } = reviewItems(plugin, o.all, o.date); ringLinks = new Map(items.map(i => [i.key, { ticket: i.ticket, project: i.project }]));
  const now = nowMin(); const log = plugin.workday.log; const [winFrom, winTo] = plugin.workWindowFor(o.date); const lunch = plugin.lunchFor(o.date);
  const worked = workedOn(log, now, plugin.dayRules); const breaks = log ? breakMinutes(log) + (log.open ? Math.max(0, now - hmToMin(log.open.start)) : 0) : 0;
  const { plannedItems, planned, comparableActual, focus } = dayTotals(items, hasPlan);
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
  drawTimeline(tl, { items, events: o.events, window: [winFrom, winTo], lunch, start: startAt, end: endAt, breaks: (log?.breaks ?? []).map((b): [number, number] => [hmToMin(b.start), hmToMin(b.end)]), hasPlan, linkRoot: grid, cap: capIn });
  const untimed = hasPlan ? plannedItems.filter(i => !i.slots.length).length : 0;
  if (untimed) tl.createDiv({ cls: "samaya-rv-note", text: `${untimed} planned ${untimed === 1 ? "task" : "tasks"} had no time slot, so ${untimed === 1 ? "it is" : "they are"} not on the planned timeline.` });
  if (!hasPlan) tl.createDiv({ cls: "samaya-rv-note", text: "No plan was saved when this day was planned, so today's list is used as the plan." });

  // ---- left: a headline, three numbers (the day, the tasks, the focus time), then where the time went
  const v = verdict(planned, comparableActual, plannedItems.length, focus);
  const head = info.createDiv("samaya-rv-head");
  head.createDiv({ cls: "samaya-rv-vtitle", text: v.title });
  head.createDiv({ cls: "samaya-rv-vtext", text: v.text });
  const stats = info.createDiv("samaya-rv-stats");
  const stat = (label: string, value: string, sub: string, delta = "", tone = "") => {
    const t = stats.createDiv("samaya-rv-stat"); t.createDiv({ cls: "samaya-rv-stat-l", text: label }); t.createDiv({ cls: "samaya-rv-stat-v", text: value });
    const s = t.createDiv("samaya-rv-stat-s"); if (sub) s.createSpan({ text: sub }); if (delta) s.createSpan({ cls: `samaya-rv-stat-d ${tone}`, text: delta });
  };
  stat("Worked", fmtDur(worked), startAt !== null ? `${minToHm(startAt)}–${endAt !== null ? minToHm(endAt) : "?"}` : "");
  stat("Time on tasks", fmtDur(focus), planned ? `plan ${fmtDur(planned)}` : "", planned ? signed(focus - planned, fmtDur) : "", planned > 0 && focus > planned ? "is-warn" : "is-ok");

  // ---- every task of the day, the changes first: takes the height that is left and scrolls when it is too long
  // ---- the tasks of the day in three tabs: what was done as planned, what stayed open, what nobody planned
  const tabs: Array<{ id: TaskTab; label: string; tip: string; empty: string; rows: Row[] }> = [
    { id: "done", label: "Done", tip: "Planned and checked off", empty: "Nothing from the plan was checked off.", rows: rows.filter(r => !r.unplanned && r.done) },
    { id: "open", label: "Open", tip: "Planned, but not checked off", empty: "Everything that was planned got done.", rows: rows.filter(r => !r.unplanned && !r.done) },
    { id: "extra", label: "Unplanned", tip: "Not on the plan: tracked or checked off anyway", empty: "No unplanned work.", rows: rows.filter(r => r.unplanned) },
  ];
  if (!tabs.some(t => t.id === memory.tab && t.rows.length)) memory.tab = (tabs.find(t => t.id === "open" && t.rows.length) ?? tabs.find(t => t.rows.length) ?? tabs[0]).id; // open on what needs a look, else the first with tasks
  const sec = info.createDiv("samaya-rv-sec is-grow");
  if (!rows.length) sec.createDiv({ cls: "samaya-empty", text: "Nothing was planned or done today." });
  else {
    const bar = sec.createDiv({ cls: "samaya-rv-tabs", attr: { role: "tablist" } }); const table = sec.createDiv("samaya-rv-table samaya-rv-scroll");
    const show = () => {
      bar.querySelectorAll<HTMLElement>(".samaya-rv-tab").forEach(b => { const on = b.dataset.tab === memory.tab; b.toggleClass("is-on", on); b.setAttr("aria-selected", String(on)); });
      table.empty(); const t = tabs.find(x => x.id === memory.tab)!;
      if (!t.rows.length) table.createDiv({ cls: "samaya-rv-empty", text: t.empty });
      for (const r of t.rows) drawRow(table, r, grid);
    };
    for (const t of tabs) {
      const b = bar.createEl("button", { cls: "samaya-rv-tab", attr: { role: "tab", "aria-label": t.tip } }); b.dataset.tab = t.id;
      b.createSpan({ text: t.label }); b.createSpan({ cls: "samaya-rv-tab-n" + (t.rows.length ? "" : " is-zero"), text: String(t.rows.length) });
      b.onclick = () => { memory.tab = t.id; show(); };
    }
    show();
  }
}

/** Time per ticket and per project, one ring under the other (drawn in the guide column, under the End my day button). Nothing is drawn when neither is in use. */
export function renderReviewRings(plugin: SamayaPlugin, host: HTMLElement, o: { date: string; all: Task[]; events: ReviewEvent[] }) {
  setOpener(plugin); const { items } = reviewItems(plugin, o.all, o.date); const log = plugin.workday.log;
  drawRings(host, items, meetingLinksOf(plugin, o.events), workedOn(log, nowMin(), plugin.dayRules));
}

/** One task of the comparison table: its planned and actual start and length, what differs as chips, the gap in tracked time. */
function drawRow(table: HTMLElement, r: Row, root: HTMLElement) {
  const row = table.createDiv("samaya-rv-r"); row.dataset.k = r.key; linkHover(row, root, r.key); clickable(row, r.key);
  const ic = row.createSpan("samaya-rv-row-ic" + (r.done ? " is-done" : "")); if (r.done) { setIcon(ic, ICON_OK); ic.setAttr("aria-label", "Done"); }
  const name = row.createDiv("samaya-rv-r-name"); name.createDiv({ cls: "samaya-rv-r-title", text: r.label }); // the name wraps instead of being cut off
  if (!r.unplanned) name.createDiv({ cls: "samaya-rv-r-plan", text: `planned ${when(r.plannedAt, r.planned)}` });
  const nums = row.createDiv("samaya-rv-r-nums"); // what it really took, and how that compares to the plan
  nums.createDiv({ cls: "samaya-rv-r-act" + (r.actual ? "" : " is-none"), text: r.actual ? fmtDur(r.actual) : r.done ? "untracked" : r.unplanned ? "–" : "not worked" });
  const d = r.planned && r.actual ? r.actual - r.planned : 0;
  if (Math.abs(d) >= 5) { const dl = nums.createDiv("samaya-rv-delta" + (d > 0 ? " is-over" : " is-under")); setIcon(dl.createSpan(), d > 0 ? ICON_UP : ICON_DOWN); dl.createSpan({ text: fmtDur(Math.abs(d)) }); }
}

type TaskTab = "done" | "open" | "extra";
const memory = { tab: "open" as TaskTab }; // the tab stays while the planner redraws
/** The ticket / project of each task of the review, by task key: hovering the task lights up its part of the rings. */
let ringLinks = new Map<string, { ticket: string; project: string }>();
function hotRings(root: HTMLElement, key: string | null) {
  const l = key ? ringLinks.get(key) : undefined;
  root.closest(".samaya-daily")?.querySelectorAll<HTMLElement>(".samaya-rv-ring").forEach(box => {
    const label = !l ? null : box.dataset.by === "ticket" ? l.ticket || "No ticket" : l.project || "No project";
    box.dispatchEvent(new CustomEvent("samaya-hot", { detail: label }));
  });
}
/** Hovering a task anywhere (timeline block or table row) lights up the same task everywhere else, and its ticket / project in the rings. */
function linkHover(el: HTMLElement, root: HTMLElement, key: string) {
  el.addEventListener("mouseenter", () => { root.addClass("is-linking"); root.querySelectorAll<HTMLElement>("[data-k]").forEach(x => x.toggleClass("is-linked", x.dataset.k === key)); hotRings(root, key); });
  el.addEventListener("mouseleave", () => { root.removeClass("is-linking"); root.querySelectorAll(".is-linked").forEach(x => x.removeClass("is-linked")); hotRings(root, null); });
}

interface TimelineIn { items: ReviewItem[]; events: ReviewEvent[]; window: [number, number]; lunch: [number, number]; start: number | null; end: number | null; breaks: Array<[number, number]>; hasPlan: boolean; linkRoot: HTMLElement; cap: CapIn; }
const MIN_HOUR_PX = 20; // the lanes fill the column (CSS); this is the least height an hour gets
/** Two lanes on one time axis: the plan as dashed outlines, the day as filled blocks. What was never worked is a faded outline, what nobody planned wears the accent colour. */
export function drawTimeline(host: HTMLElement, t: TimelineIn) {
  const spans = t.items.flatMap(i => [...i.slots, ...i.spans]);
  const [h0, h1] = hourRange([t.window[0], t.window[1], ...spans.flatMap(g => [g.s, g.e]), ...t.events.flatMap(e => [e.s, e.e]), ...(t.start !== null ? [t.start] : []), ...(t.end !== null ? [t.end] : [])]);
  const pct = (m: number) => ((Math.min(h1 * 60, Math.max(h0 * 60, m)) - h0 * 60) / ((h1 - h0) * 60)) * 100; // positions in percent of the lane: it stretches with the pane, no measuring
  const box = host.createDiv("samaya-rv-tl");
  const head = box.createDiv("samaya-rv-tl-head"); head.createSpan();
  head.createDiv("samaya-rv-tl-col").createSpan({ text: "Planned" }); drawCap(head.lastElementChild as HTMLElement, t.cap.plan, t.cap);
  head.createDiv("samaya-rv-tl-col").createSpan({ text: "Actual" }); drawCap(head.lastElementChild as HTMLElement, t.cap.act, t.cap);
  const body = box.createDiv("samaya-rv-tl-body"); body.style.setProperty("--h", String(h1 - h0)); body.style.minHeight = `${(h1 - h0) * MIN_HOUR_PX}px`;
  const axis = body.createDiv("samaya-rv-axis");
  for (let h = h0; h < h1; h++) axis.createSpan({ cls: "samaya-rv-hour", text: minToHm(h * 60) }).style.top = `${((h - h0) / (h1 - h0)) * 100}%`;
  const lane = (cls: string) => { return body.createDiv(`samaya-rv-lane ${cls}`); };
  const band = (l: HTMLElement, cls: string, a: number, b: number) => { if (b <= a) return; const d = l.createDiv(`samaya-rv-band ${cls}`); d.style.top = `${pct(a)}%`; d.style.height = `${Math.max(0, pct(b) - pct(a))}%`; return d; };
  const edge = (l: HTMLElement, a: number, b: number) => { // the lane's first and last minute, as times
    l.createDiv({ cls: "samaya-rv-edge is-top", text: minToHm(a) }).style.top = `${pct(a)}%`;
    l.createDiv({ cls: "samaya-rv-edge is-bottom", text: minToHm(b) }).style.top = `${pct(b)}%`;
  };
  const block = (l: HTMLElement, cls: string, a: number, b: number, text: string, time: string, tip: string, key?: string) => {
    const d = l.createDiv(`samaya-rv-blk ${cls}`); d.style.top = `${pct(a)}%`; d.style.height = `calc(${Math.max(0, pct(b) - pct(a))}% - 1px)`; d.setAttr("aria-label", tip);
    d.createSpan({ cls: "samaya-rv-blk-t", text }); d.createSpan({ cls: "samaya-rv-blk-m", text: time });
    if (key) { d.dataset.k = key; linkHover(d, t.linkRoot, key); clickable(d, key); }
    return d;
  };
  const meetings = (l: HTMLElement) => t.events.forEach(e => { const d = block(l, "is-meeting", e.s, e.e, e.title, `${minToHm(e.s)}–${minToHm(e.e)}`, `${e.title} · ${minToHm(e.s)}–${minToHm(e.e)}`); if (e.notePath) clickable(d, e.notePath); });
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
/** A day's capacity as one bar: meetings, then tasks, then other work, on `scale` minutes. The notch is where the buffer starts (like the notch in the capacity bars elsewhere): the end of the plannable time is kept free for what nobody can foresee. The details are in tooltips. */
function drawCap(host: HTMLElement, segs: CapSeg[], c: CapIn) {
  const bar = host.createDiv("samaya-rv-cap"); const fills: Array<[HTMLElement, number]> = [];
  if (c.buffer) { const b = bar.createDiv("samaya-rv-cap-buffer"); b.style.left = `${(c.buffer[0] / c.scale) * 100}%`; b.setAttr("aria-label", c.bufferTip); }
  const row = bar.createDiv("samaya-rv-cap-segs");
  for (const g of segs) if (g.m > 0) { const e = row.createDiv(`samaya-rv-cap-seg ${g.cls}`); e.style.width = "0%"; e.setAttr("aria-label", g.tip); fills.push([e, (g.m / c.scale) * 100]); }
  settle(() => fills.forEach(([e, w]) => { e.style.width = `${w}%`; }));
}

/** Hue for the n-th ticket / project; the "none" group is grey. */
const hueOf = (n: number) => `hsl(${(n * 137.5 + 150) % 360} 48% 58%)`;
const RING_R = 38, RING_C = 2 * Math.PI * RING_R;
/** One ring per grouping in use (tickets, projects): how the tracked time divides up, with the biggest first in a list beside it. */
function drawRings(host: HTMLElement, items: ReviewItem[], meetings: MeetingLink[], worked: number) {
  const kinds = (["ticket", "project"] as Grouping[]).map(by => ({ by, groups: hasGroups(items, by, meetings) ? timeGroups(items, by, meetings, worked) : [] })).filter(k => k.groups.length);
  if (!kinds.length) return;
  const wrap = host.createDiv("samaya-rv-rings"); // side by side, centred (one ring alone sits in the middle)
  for (const { by, groups } of kinds) {
    const none = by === "ticket" ? "No ticket" : "No project";
    const total = groups.reduce((a, g) => a + g.actual, 0); const colour = (label: string, n: number) => (label === none ? "var(--rv-other)" : hueOf(n));
    const card = wrap.createDiv("samaya-rv-ringcard"); card.createDiv({ cls: "samaya-rv-ring-t", text: by === "ticket" ? "Tickets" : "Projects" });
    const box = card.createDiv("samaya-rv-ring");
    const svg = box.createSvg("svg", { attr: { viewBox: "0 0 100 100", role: "img" } }); srName(svg, `Time per ${by}`, box);
    svg.createSvg("circle", { attr: { class: "samaya-rv-ring-bg", cx: "50", cy: "50", r: String(RING_R) } });
    const time = box.createDiv("samaya-rv-ring-mid").createSpan("samaya-rv-ring-n"); // the time of the part under the pointer
    box.dataset.by = by; const handlers = new Map<string, [() => void, () => void]>(); let lit: string | null = null;
    box.addEventListener("samaya-hot", e => { // a task is hovered somewhere else: light up its part (null: none)
      const label = (e as CustomEvent<string | null>).detail; if (lit) handlers.get(lit)?.[1](); lit = null;
      if (label && handlers.has(label)) { lit = label; handlers.get(label)![0](); }
    });
    const legend = card.createDiv("samaya-rv-ringlegend"); // minimal: colour, name, time
    const gapLen = groups.length > 1 ? 1.6 : 0; let at = 0; const arcs: Array<[SVGElement, number, number]> = [];
    groups.forEach((g, n) => {
      let c: SVGElement | null = null; // a ticket / project without time has a legend entry but no arc
      if (g.actual > 0) {
        const len = (g.actual / total) * RING_C;
        c = svg.createSvg("circle", { attr: { class: "samaya-rv-ring-seg", cx: "50", cy: "50", r: String(RING_R), transform: "rotate(-90 50 50)", "stroke-dasharray": `0 ${RING_C}`, "stroke-dashoffset": String(-at) } });
        c.style.stroke = colour(g.label, n); arcs.push([c, Math.max(0.5, len - gapLen), len]); at += len;
      }
      const row = legend.createDiv("samaya-rv-lg" + (g.actual > 0 ? "" : " is-empty")); row.createSpan("samaya-rv-dot").style.background = colour(g.label, n);
      row.createSpan({ cls: "samaya-rv-lg-name", text: g.label, attr: { "aria-label": g.label } });
      const on = () => { time.setText(fmtDur(Math.round(g.actual))); if (c) { box.addClass("is-hover"); c.classList.add("is-hot"); } row.addClass("is-hot"); };
      const off = () => { time.setText(""); box.removeClass("is-hover"); c?.classList.remove("is-hot"); row.removeClass("is-hot"); };
      handlers.set(g.label, [on, off]);
      const note = g.target ? appRef?.metadataCache.getFirstLinkpathDest(g.target, "") : null; // the ticket / project note: click opens it
      for (const el of [c, row]) if (el) { el.addEventListener("mouseenter", on); el.addEventListener("mouseleave", off); if (note) clickable(el, note.path); }
    });
    settle(() => arcs.forEach(([c, shown]) => c.setAttribute("stroke-dasharray", `${shown} ${RING_C - shown}`)));
  }
}
