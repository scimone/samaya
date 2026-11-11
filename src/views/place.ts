import type SamayaPlugin from "../main";
import type { IcsEvent } from "../ics";
import { Task, allTasks, onDay, readTask, restPlaceOf, writeDayPlan, writeSessions } from "../model";
import { MergeSegmentsModal } from "../modals";
import { Seg, mergeOffer, planInWindow, segsTotal } from "../segments";
import { NO_REST, Piece, Session, addMinutes, sessionsTotal, dayMinutes, dayPieces, pieceLength, replaceDay, sortSessions, splitPiece, takePiece, withoutDay } from "../sessions";
import { calendarEnabled, calendarEvents } from "../calendar";
import { Horizon, addDays, fmtDur, hmToMin, horizonTarget, parseYmd, startOfWeek, today } from "../util";
import { nowMin } from "../workday";
import { Notice, TFile, setIcon } from "obsidian";

/** Meetings and lunch of a day as [start, end] minutes (with `borders`: also the time outside the day start/finish lines). */
export function busyIntervals(plugin: SamayaPlugin, date: string, events: IcsEvent[], borders = false): Array<[number, number]> {
  const dayMs = parseYmd(date).getTime();
  const iv = events.filter(e => !e.allDay).map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]);
  iv.push(plugin.lunchFor(date));
  if (borders) { const [from, to] = plugin.workWindowFor(date); iv.push([0, from], [to, 1440]); }
  return iv;
}

/** The blocks a task occupies on the timeline: its segments, or one block from `start` with the estimate. */
export function taskBlocks(t: Task, dflt: number): Seg[] {
  return t.segments.length > 1 ? t.segments : [{ s: hmToMin(t.start), dur: t.estimate || dflt }];
}
/** Is this task being worked on right now: planned today, not done, and one of its blocks covers the current time? */
export function isOngoing(t: Task, dflt: number): boolean {
  if (t.status === "done" || t.planned !== today() || !t.start) return false;
  const n = nowMin(); return taskBlocks(t, dflt).some(g => n >= g.s && n < g.s + g.dur);
}
/** Small Focus button: starts focus mode on the task (not shown while it is already being focused). */
export function focusButton(plugin: SamayaPlugin, parent: HTMLElement, t: Task, cls = "samaya-mini samaya-focus-go"): HTMLElement | null {
  if (plugin.focus.state?.path === t.file.path && plugin.focus.state.startedAt) return null;
  const b = parent.createEl("button", { cls, attr: { "aria-label": "Start focus on this task" } });
  setIcon(b.createSpan({ cls: "samaya-focus-go-icon" }), "timer"); b.createSpan({ text: "Focus" });
  b.addEventListener("pointerdown", e => e.stopPropagation()); // not a drag
  b.addEventListener("click", e => { e.stopPropagation(); void plugin.focus.start(t.file); });
  return b;
}
/** Length of what is being dragged: the unplanned rest, one piece, a day's pieces or the whole task. */
export function dragLen(plugin: SamayaPlugin, path: string, seg: number | null, fromDay: string | null): number {
  const f = plugin.app.vault.getAbstractFileByPath(path); const dflt = plugin.settings.defaultEstimate;
  if (!(f instanceof TFile)) return dflt;
  const t = readTask(plugin.app, f); return pieceLength(t.sessions, t.rest, t.estimate, fromDay, seg, dflt);
}

/** Marks the pieces of a split task (on one day or on several) and lights up all of them while one is hovered. `n` = pieces on this day. */
export function decorateSegment(b: HTMLElement, t: Task, k: number, n: number, scope: HTMLElement) {
  if (n < 2 && !t.part) return;
  b.addClass("is-split"); b.dataset.task = t.file.path; if (n > 1) b.dataset.seg = String(k);
  const nth = (t.part?.nth ?? 0) + k + 1; const count = t.part?.count ?? n;
  const mark = b.querySelector(".samaya-block-title")?.createSpan({ cls: "samaya-split-mark", attr: { title: splitTitle(t) } });
  if (mark) { setIcon(mark.createSpan({ cls: "samaya-split-icon" }), "scissors"); mark.createSpan({ text: `${nth}/${count}` }); }
  const all = () => Array.from(scope.querySelectorAll<HTMLElement>(".samaya-block.is-split")).filter(x => x.dataset.task === t.file.path);
  b.addEventListener("mouseenter", () => all().forEach(x => x.addClass("is-linked")));
  b.addEventListener("mouseleave", () => all().forEach(x => x.removeClass("is-linked")));
}
/** "Also: Thu 12 · 1h, Fri 13 · 30m, 45m not planned yet" */
export function splitTitle(t: Task): string {
  const p = t.part; if (!p) return "Split task";
  const bits = p.others.map(o => `${parseYmd(o.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}, ${fmtDur(o.dur)}`);
  if (p.kind === "day" && p.rest) bits.push(`${fmtDur(p.rest)} not planned yet`);
  return bits.length ? `Split task. Also: ${bits.join(", ")}` : "Split task";
}
export const segLabel = (_k: number, _n: number): string => ""; // the piece number sits next to the scissors icon in the title

/**
 * Drop on the timeline at `startMin`. A task flows around meetings and lunch (split into segments); a dragged segment of a
 * split task only moves itself, and offers to merge when the pieces fit together again. `fromDay` is the day the dragged card or block
 * belongs to ("" = the unplanned rest of a task): a task planned in several pieces only brings the piece that was grabbed.
 */
export async function dropOnTimeline(plugin: SamayaPlugin, file: TFile, date: string, startMin: number, seg: number | null, fromDay: string | null, events: IcsEvent[], limit: number, slot: number) {
  const app = plugin.app; const t = readTask(app, file); const dflt = plugin.settings.defaultEstimate;
  const place = restPlaceOf(t);
  const write = async (ss: Session[], rest: number, placed: Seg[]) => { await writeSessions(app, file, ss, rest, place); await makeRoom(plugin, file, date, placed, events, limit, slot); };
  const pieces = (ss: Session[], ps: Seg[]) => replaceDay(ss, date, ps);
  const busy = busyIntervals(plugin, date, events, true);
  const from = fromDay === "" ? "" : fromDay && dayPieces(t.sessions, fromDay).length ? fromDay : t.planned;

  const there = dayPieces(t.sessions, date).filter(g => g.s !== null);
  if (seg !== null && from === date && there.length > 1) { // one piece of a split day moves inside its day
    const segs = there.map((g): Seg => ({ s: g.s!, dur: g.dur })); const moved = segs[seg]; moved.s = startMin; segs.sort((a, b) => a.s - b.s);
    const offer = mergeOffer(segs, segs.indexOf(moved), busy, limit);
    if (offer) { const total = segsTotal(segs); new MergeSegmentsModal(plugin, total, merge => { void (merge ? write(pieces(t.sessions, [{ s: offer.at, dur: total }]), t.rest, [{ s: offer.at, dur: total }]) : write(pieces(t.sessions, segs), t.rest, segs)); }).open(); return; }
    await write(pieces(t.sessions, segs), t.rest, segs); return;
  }

  let ss = t.sessions; let rest = t.rest; let mins: number;
  if (!from) { mins = rest > 0 ? rest : t.estimate || dflt; rest = 0; } // the rest of a task, or a task without a day
  else { const r = takePiece(ss, from, seg); ss = r.left; mins = r.mins || t.estimate || dflt; }
  if (from !== date) { mins += dayMinutes(ss, date); ss = withoutDay(ss, date); } // the task's pieces already on this day are planned again together with the newcomer
  const [wFrom, wTo] = plugin.workWindowFor(date); const earliest = date === today() ? nowMin() : 0; // today: nothing before the current time
  const plan = planInWindow(startMin, mins, busyIntervals(plugin, date, events), wFrom, wTo, earliest, limit, slot);
  const placed: Seg[] = plan && plan.length > 1 ? plan : [{ s: plan ? plan[0].s : startMin, dur: mins }];
  await write(pieces(ss, placed), rest, placed);
}

/**
 * A task was dropped onto `placed`: every other open task of the day that overlaps it (or a task pushed by it) makes space
 * and moves to the next free time, splitting around meetings and other tasks when needed.
 */
async function makeRoom(plugin: SamayaPlugin, dropped: TFile, date: string, placed: Seg[], events: IcsEvent[], limit: number, slot: number) {
  const app = plugin.app; const dflt = plugin.settings.defaultEstimate;
  const [from, to] = plugin.workWindowFor(date); const earliest = date === today() ? nowMin() : 0;
  const meet = busyIntervals(plugin, date, events);
  const occupied: Array<[number, number]> = placed.map((g): [number, number] => [g.s, g.s + g.dur]);
  const hit = (blocks: Seg[]) => blocks.some(g => occupied.some(([a, b]) => g.s < b && a < g.s + g.dur));
  const others = onDay(allTasks(app, plugin.settings).filter(o => o.file.path !== dropped.path), date).filter(o => o.start)
    .sort((a, b) => hmToMin(a.start) - hmToMin(b.start));
  for (const o of others) {
    const blocks = taskBlocks(o, dflt);
    if (o.status === "done" || !hit(blocks)) { blocks.forEach(g => occupied.push([g.s, g.s + g.dur])); continue; }
    const total = segsTotal(blocks);
    const plan = planInWindow(Math.min(...blocks.map(g => g.s)), total, [...meet, ...occupied], from, to, earliest, limit, slot);
    if (!plan) { blocks.forEach(g => occupied.push([g.s, g.s + g.dur])); continue; }
    plan.forEach(g => occupied.push([g.s, g.s + g.dur]));
    await writeDayPlan(app, o.file, date, plan);
  }
}

/** New length of one block: a piece of a split task changes its own length, the total follows. `t` is the day's view of the task. */
export async function resizeBlock(plugin: SamayaPlugin, t: Task, seg: number, dur: number) {
  const pieces: Piece[] = t.segments.length > 1 ? t.segments.map(g => ({ s: g.s, dur: g.dur })) : [{ s: hmToMin(t.start), dur }];
  if (t.segments.length > 1) pieces[seg].dur = dur;
  await writeDayPlan(plugin.app, t.file, t.planned, pieces);
}

// ---------- splitting a task by hand ----------
/** Where the rest of a split goes: right after the first part (same day), another day, this week's list or the backlog. */
export type SplitTo = { kind: "same" } | { kind: "day"; date: string } | { kind: "week"; week: string } | { kind: "backlog"; horizon: Horizon };

async function dayEvents(plugin: SamayaPlugin, date: string): Promise<IcsEvent[]> {
  return calendarEnabled(plugin.settings) ? calendarEvents(plugin, parseYmd(date), parseYmd(addDays(date, 1))).catch(() => [] as IcsEvent[]) : [];
}
/** Cut one piece of a task (piece `seg` of `day`; null = the day's only piece) in two: `first` minutes stay, the rest goes to `to`. False when nothing was split. */
export async function splitTask(plugin: SamayaPlugin, file: TFile, day: string, seg: number | null, first: number, to: SplitTo): Promise<boolean> {
  const app = plugin.app; const s = plugin.settings; const t = readTask(app, file);
  const cut = splitPiece(t.sessions, day, seg, first); if (!cut) return false;
  let ss = cut.sessions; let rest = t.rest; let place = restPlaceOf(t);
  let placed: Seg[] = []; let events: IcsEvent[] = [];
  if (to.kind === "same") {
    if (cut.at === null) return false;
    events = await dayEvents(plugin, day); const [wFrom, wTo] = plugin.workWindowFor(day);
    const mine = dayPieces(ss, day).filter(g => g.s !== null).map((g): [number, number] => [g.s!, g.s! + g.dur]);
    const plan = planInWindow(cut.at, cut.left, [...busyIntervals(plugin, day, events), ...mine], wFrom, wTo, day === today() ? nowMin() : 0, s.dayEndHour * 60, s.slotMinutes);
    if (!plan) { new Notice("Samaya: there is no room left on this day for the second part."); return false; }
    placed = plan; ss = sortSessions([...ss, ...plan.map((g): Session => ({ date: day, s: g.s, dur: g.dur }))]);
  } else if (to.kind === "day") ss = addMinutes(ss, to.date, cut.left);
  else {
    rest += cut.left;
    place = to.kind === "week" ? { week: to.week, later: null, horizon: null } : { week: null, later: horizonTarget(to.horizon, today()) || null, horizon: to.horizon };
  }
  await writeSessions(app, file, ss, rest, place);
  if (placed.length) await makeRoom(plugin, file, day, placed, events, s.dayEndHour * 60, s.slotMinutes);
  return true;
}

/** Join all parts of a task (every day, and the rest) into one piece on `day`: at the time of that day's first slot, or without a time when it has none. */
export async function joinParts(plugin: SamayaPlugin, file: TFile, day: string) {
  const s = plugin.settings; const t = readTask(plugin.app, file);
  const total = sessionsTotal(t.sessions) + t.rest; if (!total) return;
  const timed = dayPieces(t.sessions, day).filter(g => g.s !== null);
  if (!timed.length) { await writeSessions(plugin.app, file, [{ date: day, s: null, dur: total }], 0, NO_REST); return; }
  const events = await dayEvents(plugin, day); const [wFrom, wTo] = plugin.workWindowFor(day);
  const plan = planInWindow(timed[0].s!, total, busyIntervals(plugin, day, events), wFrom, wTo, day === today() ? nowMin() : 0, s.dayEndHour * 60, s.slotMinutes) ?? [{ s: timed[0].s!, dur: total }];
  await writeSessions(plugin.app, file, plan.map((g): Session => ({ date: day, s: g.s, dur: g.dur })), 0, NO_REST);
  await makeRoom(plugin, file, day, plan, events, s.dayEndHour * 60, s.slotMinutes);
}
