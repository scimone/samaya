import { setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { Task, onDay, readTicket } from "../model";
import { projectPathOf } from "../projects";
import { Grouping, ReviewItem, daySplit, groupRows, hasGroups, runMinutesOn, taskRows, verdict } from "../dayreview";
import { breakMinutes, workedMinutes } from "../worktime";
import { fmtDur } from "../util";
import { nowMin } from "../workday";

/** Everything the review needs. The baseline is the plan saved when the day was first planned; without one, today's list as it is now (`hasPlan` false). */
function reviewItems(plugin: SamayaPlugin, all: Task[], date: string): { items: ReviewItem[]; hasPlan: boolean } {
  const app = plugin.app; const snap = plugin.data.dayPlans?.[date]; const hasPlan = !!snap;
  const now = new Map(onDay(all, date).map(t => [t.file.path, t]));
  const base = new Map<string, number>(snap ? snap.map(x => [x.path, x.est] as [string, number]) : [...now].map(([p, t]) => [p, t.estimate] as [string, number]));
  const items: ReviewItem[] = [];
  for (const t of all) {
    const fm = (app.metadataCache.getFileCache(t.file)?.frontmatter ?? {}) as Record<string, unknown>;
    const runs = Array.isArray(fm.focus_sessions) ? fm.focus_sessions : fm.focus_sessions ? [fm.focus_sessions] : [];
    const actual = runMinutesOn(runs, date); const est = base.get(t.file.path);
    const doneToday = t.status === "done" && String(fm.day_completed ?? "").slice(0, 10) === date; // ticked off today, even if never planned or timed
    if (est === undefined && !actual && !doneToday) continue;
    const tf = t.ticket ? app.metadataCache.getFirstLinkpathDest(t.ticket, t.file.path) : null;
    const pp = plugin.settings.projectsOn ? projectPathOf(app, t.file) : "";
    items.push({ title: t.title, wasPlanned: est !== undefined || !hasPlan, planned: est ?? 0, actual, done: t.status === "done", ticket: tf ? readTicket(app, tf).key : "", project: pp ? pp.split("/").pop()!.replace(/\.md$/, "") : "" });
  }
  return { items, hasPlan };
}

/** The charts grow in once; the planner re-renders often, and a re-render soon after the last one shows the final state at once. */
let lastShown = 0; let anim = true;
const settle = (fn: () => void) => { if (anim) requestAnimationFrame(() => requestAnimationFrame(fn)); else fn(); };

const ICON_OK = "check", ICON_UP = "trending-up", ICON_DOWN = "trending-down";

/** Second step of "End my day": the day in numbers and charts - how the time was spent, and how that compares with the plan. */
export function renderDayReview(plugin: SamayaPlugin, host: HTMLElement, o: { date: string; all: Task[]; meetings: number }) {
  anim = Date.now() - lastShown > 4000; lastShown = Date.now();
  const grid = host.createDiv("samaya-rv"); const box = grid.createDiv("samaya-rv-col"); const side = grid.createDiv("samaya-rv-col"); const { items, hasPlan } = reviewItems(plugin, o.all, o.date);
  const log = plugin.workday.log; const worked = workedMinutes(log, nowMin()); const breaks = log ? breakMinutes(log) + (log.open ? Math.max(0, nowMin() - Number(log.open.start.slice(0, 2)) * 60 - Number(log.open.start.slice(3, 5))) : 0) : 0;
  const focus = items.reduce((a, i) => a + i.actual, 0); const planned = items.reduce((a, i) => a + i.planned, 0);
  const plannedItems = items.filter(i => i.wasPlanned); const added = hasPlan ? items.filter(i => !i.wasPlanned) : []; const done = plannedItems.filter(i => i.done).length;
  const comparable = plannedItems.reduce((a, i) => a + i.planned, 0); const comparableActual = plannedItems.reduce((a, i) => a + i.actual, 0);
  const sp = daySplit(worked, focus, o.meetings, breaks);

  // ---- hero: completion ring and a one-line verdict
  const addedDone = added.filter(i => i.done).length;
  const v = verdict(comparable, comparableActual, done, plannedItems.length);
  const hero = box.createDiv("samaya-rv-hero");
  const ring = hero.createDiv("samaya-rv-ring"); const R = 34, C = 2 * Math.PI * R; const frac = plannedItems.length ? done / plannedItems.length : 0;
  const svg = ring.createSvg("svg", { attr: { viewBox: "0 0 80 80", width: "84", height: "84", role: "img", "aria-label": `${done} of ${plannedItems.length} planned tasks done` } });
  svg.createSvg("circle", { attr: { class: "samaya-rv-ring-bg", cx: "40", cy: "40", r: String(R) } });
  const arc = svg.createSvg("circle", { attr: { class: "samaya-rv-ring-fg" + (frac >= 1 ? " is-complete" : ""), cx: "40", cy: "40", r: String(R), "stroke-dasharray": String(C), "stroke-dashoffset": String(C), transform: "rotate(-90 40 40)" } });
  const mid = ring.createDiv("samaya-rv-ring-mid"); mid.createSpan({ cls: "samaya-rv-ring-n", text: `${done}/${plannedItems.length}` }); mid.createSpan({ cls: "samaya-rv-ring-l", text: "done" });
  const vt = hero.createDiv("samaya-rv-verdict"); vt.createDiv({ cls: "samaya-rv-vtitle", text: v.title }); vt.createDiv({ cls: "samaya-rv-vtext", text: v.text + (addedDone ? ` Plus ${addedDone} ${addedDone === 1 ? "task" : "tasks"} you added along the way.` : "") });
  settle(() => arc.setAttribute("stroke-dashoffset", String(C * (1 - frac))));

  // ---- stat tiles
  const tiles = box.createDiv("samaya-rv-tiles");
  const tile = (label: string, value: string, cls: string, sub = "") => { const t = tiles.createDiv(`samaya-rv-tile ${cls}`); t.createDiv({ cls: "samaya-rv-tile-l", text: label }); t.createDiv({ cls: "samaya-rv-tile-v", text: value }); if (sub) t.createDiv({ cls: "samaya-rv-tile-s", text: sub }); };
  tile("Worked", fmtDur(worked), "is-worked", log ? `${log.start} – now` : "");
  tile("Focused", fmtDur(sp.focus), "is-focus", worked ? `${Math.round((sp.focus / worked) * 100)}% of the day` : "");
  tile("Meetings", fmtDur(sp.meetings), "is-meet", worked ? `${Math.round((sp.meetings / worked) * 100)}% of the day` : "");
  tile("Breaks", fmtDur(sp.breaks), "is-break");

  // ---- the day as one bar
  if (sp.total > 0) {
    box.createDiv({ cls: "samaya-rv-h", text: "How your day was spent" });
    const bar = box.createDiv("samaya-rv-split");
    const parts: Array<[string, string, number]> = [["is-focus", "Focused on tasks", sp.focus], ["is-meet", "Meetings", sp.meetings], ["is-other", "Other work", sp.other], ["is-break", "Breaks", sp.breaks]];
    const segs = parts.filter(p => p[2] > 0).map(([cls, name, m]) => { const s = bar.createDiv(`samaya-rv-seg ${cls}`); s.title = `${name}: ${fmtDur(m)}`; s.style.flexGrow = "0"; s.style.width = "0%"; return [s, m] as const; });
    settle(() => segs.forEach(([s, m]) => { s.style.width = `${(m / sp.total) * 100}%`; }));
    const legend = box.createDiv("samaya-rv-legend");
    for (const [cls, name, m] of parts) if (m > 0) { const l = legend.createSpan("samaya-rv-legend-item"); l.createSpan({ cls: `samaya-rv-swatch ${cls}` }); l.createSpan({ text: `${name} ${fmtDur(m)}` }); }
    if (!focus && worked) box.createDiv({ cls: "samaya-rv-note", text: "Time on tasks comes from the focus timer. Start it on a task to see where the day goes." });
  }

  // ---- planned vs actual (right column), then what was added during the day
  const rows = taskRows(items); const planRows = rows.filter(r => !r.unplanned), addRows = rows.filter(r => r.unplanned);
  side.createDiv({ cls: "samaya-rv-h", text: "Planned vs. actual" });
  const keyEl = side.createDiv("samaya-rv-legend");
  for (const [cls, name] of [["is-plan", "Planned"], ["is-act", "Actual"], ["is-over", "Over plan"]]) { const l = keyEl.createSpan("samaya-rv-legend-item"); l.createSpan({ cls: `samaya-rv-swatch ${cls}` }); l.createSpan({ text: name }); }
  if (!planRows.length) side.createDiv({ cls: "samaya-empty", text: "Nothing was planned for today." });
  else drawBars(side, planRows.map(r => ({ label: r.label, planned: r.planned, actual: r.actual, done: r.done, tag: "" })));
  if (!hasPlan) side.createDiv({ cls: "samaya-rv-note", text: "No plan was saved when this day was planned, so today's list is used as the plan." });
  if (addRows.length && hasPlan) {
    const h = side.createDiv({ cls: "samaya-rv-h samaya-rv-h-row" }); h.createSpan({ text: "Added during the day" }); h.createSpan({ cls: "samaya-rv-row-tag", text: `${addRows.length} not in this morning's plan` });
    drawBars(side, addRows.map(r => ({ label: r.label, planned: 0, actual: r.actual, done: r.done, tag: "" })), false, true);
  }

  // ---- by ticket / project, when those are in use
  const kinds = (["ticket", "project"] as Grouping[]).filter(k => hasGroups(items, k));
  if (kinds.length) {
    let by = kinds[0];
    const head = side.createDiv({ cls: "samaya-rv-h samaya-rv-h-row" }); const title = head.createSpan();
    const body = side.createDiv("samaya-rv-groups");
    const paint = () => {
      title.setText(by === "ticket" ? "By ticket" : "By project"); body.empty();
      const g = groupRows(items, by); drawBars(body, g.map(r => ({ label: r.label, planned: r.planned, actual: r.actual, done: false, tag: `${r.tasks} ${r.tasks === 1 ? "task" : "tasks"}` })), true);
    };
    if (kinds.length > 1) {
      const sw = head.createDiv("samaya-rv-switch");
      kinds.forEach(k => { const b = sw.createEl("button", { text: k === "ticket" ? "Tickets" : "Projects", cls: k === by ? "is-on" : "" }); b.onclick = () => { by = k; sw.querySelectorAll("button").forEach(x => x.toggleClass("is-on", x === b)); paint(); }; });
    }
    paint();
  }
  void planned;
}

interface Bar { label: string; planned: number; actual: number; done: boolean; tag: string; }
/** Two thin bars per row on a shared scale: the plan as a pale track, the actual time in front of it (orange where it passes the plan). */
function drawBars(host: HTMLElement, rows: Bar[], plain = false, added = false) {
  const max = Math.max(1, ...rows.flatMap(r => [r.planned, r.actual])); const list = host.createDiv("samaya-rv-rows"); const fills: Array<[HTMLElement, number]> = [];
  for (const r of rows) {
    const row = list.createDiv("samaya-rv-row"); const top = row.createDiv("samaya-rv-row-top");
    if (!plain) { const ic = top.createSpan("samaya-rv-row-ic" + (r.done ? " is-done" : "")); if (r.done) setIcon(ic, ICON_OK); }
    top.createSpan({ cls: "samaya-rv-row-name", text: r.label, attr: { title: r.label } });
    if (r.tag) top.createSpan({ cls: "samaya-rv-row-tag", text: r.tag });
    const nums = top.createSpan("samaya-rv-row-nums");
    nums.createSpan({ cls: "samaya-rv-row-act", text: r.actual ? fmtDur(r.actual) : "–" });
    if (r.planned) nums.createSpan({ cls: "samaya-rv-row-plan", text: ` / ${fmtDur(r.planned)}` });
    const track = row.createDiv("samaya-rv-track" + (added ? " is-added" : "")); track.title = `Planned ${r.planned ? fmtDur(r.planned) : "-"} · Actual ${r.actual ? fmtDur(r.actual) : "-"}`;
    if (r.planned) { const p = track.createDiv("samaya-rv-fill is-plan"); fills.push([p, (r.planned / max) * 100]); }
    if (r.actual) { const over = r.planned > 0 && r.actual > r.planned * 1.1; const a = track.createDiv("samaya-rv-fill is-act" + (over ? " is-over" : "")); fills.push([a, (r.actual / max) * 100]); }
    if (r.planned && r.actual) {
      const d = r.actual - r.planned;
      if (Math.abs(d) >= 5) { const c = top.createSpan("samaya-rv-delta " + (d > 0 ? "is-over" : "is-under")); setIcon(c.createSpan(), d > 0 ? ICON_UP : ICON_DOWN); c.createSpan({ text: fmtDur(Math.abs(d)) }); }
    }
  }
  settle(() => fills.forEach(([el, w]) => { el.style.width = `${w}%`; }));
}
