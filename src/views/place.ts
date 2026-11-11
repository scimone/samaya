import type SamayaPlugin from "../main";
import type { IcsEvent } from "../ics";
import { Task, allTasks, patchTask, readTask } from "../model";
import { MergeSegmentsModal } from "../modals";
import { Seg, fmtSegments, mergeOffer, planInWindow, segsTotal } from "../segments";
import { hmToMin, minToHm, parseYmd, today } from "../util";
import { nowMin } from "../workday";
import { setIcon, type TFile } from "obsidian";

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
export function focusButton(plugin: SamayaPlugin, parent: HTMLElement, t: Task, cls = "samaya-focus-go"): HTMLElement | null {
  if (plugin.focus.state?.path === t.file.path && plugin.focus.state.startedAt) return null;
  const b = parent.createEl("button", { cls, attr: { title: "Start focus on this task", "aria-label": `Start focus: ${t.title}` } });
  setIcon(b.createSpan({ cls: "samaya-focus-go-icon" }), "timer"); b.createSpan({ text: "Focus" });
  b.addEventListener("pointerdown", e => e.stopPropagation()); // not a drag
  b.addEventListener("click", e => { e.stopPropagation(); void plugin.focus.start(t.file); });
  return b;
}
/** Length of what is being dragged: one segment, or the whole task. */
export function dragDur(t: Task | undefined, seg: number | null, dflt: number): number {
  if (!t) return dflt; return seg !== null && t.segments[seg] ? t.segments[seg].dur : t.estimate || dflt;
}

/** Marks the pieces of a split task and lights up all of them while one is hovered. */
export function decorateSegment(b: HTMLElement, t: Task, k: number, n: number, scope: HTMLElement) {
  if (n < 2) return;
  b.addClass("is-split"); b.dataset.seg = String(k); b.dataset.task = t.file.path;
  const mark = b.querySelector(".samaya-block-title")?.createSpan({ cls: "samaya-split-mark" });
  if (mark) { setIcon(mark.createSpan({ cls: "samaya-split-icon" }), "scissors"); mark.createSpan({ text: `${k + 1}/${n}` }); }
  const all = () => Array.from(scope.querySelectorAll<HTMLElement>(".samaya-block.is-split")).filter(x => x.dataset.task === t.file.path);
  b.addEventListener("mouseenter", () => all().forEach(x => x.addClass("is-linked")));
  b.addEventListener("mouseleave", () => all().forEach(x => x.removeClass("is-linked")));
}
export const segLabel = (_k: number, _n: number): string => ""; // the piece number sits next to the scissors icon in the title

/**
 * Drop on the timeline at `startMin`. A task flows around meetings and lunch (split into segments); a dragged segment of a
 * split task only moves itself, and offers to merge when the pieces fit together again.
 */
export async function dropOnTimeline(plugin: SamayaPlugin, file: TFile, date: string, startMin: number, seg: number | null, events: IcsEvent[], limit: number, slot: number) {
  const app = plugin.app; const t = readTask(app, file); const dflt = plugin.settings.defaultEstimate;
  const base = { planned: date, week: null };
  const single = async (at: number, dur: number) => { await patchTask(app, file, { ...base, start: minToHm(at), estimate: dur, segments: null }); await makeRoom(plugin, file, date, [{ s: at, dur }], events, limit, slot); };
  const split = async (segs: Seg[]) => { await patchTask(app, file, { ...base, start: minToHm(segs[0].s), estimate: segsTotal(segs), segments: fmtSegments(segs) }); await makeRoom(plugin, file, date, segs, events, limit, slot); };
  const busy = busyIntervals(plugin, date, events, true);
  if (seg !== null && t.segments.length > 1) {
    const segs = t.segments.map(g => ({ ...g })); const moved = segs[seg]; moved.s = startMin; segs.sort((a, b) => a.s - b.s);
    const offer = mergeOffer(segs, segs.indexOf(moved), busy, limit);
    if (offer) { const total = segsTotal(segs); new MergeSegmentsModal(plugin, total, merge => { void (merge ? single(offer.at, total) : split(segs)); }).open(); return; }
    await split(segs); return;
  }
  const dur = t.estimate || dflt;
  const [from, to] = plugin.workWindowFor(date); const earliest = date === today() ? nowMin() : 0; // today: nothing before the current time
  const plan = planInWindow(startMin, dur, busyIntervals(plugin, date, events), from, to, earliest, limit, slot);
  if (plan && plan.length > 1) await split(plan); else await single(plan ? plan[0].s : startMin, dur);
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
  const others = allTasks(app, plugin.settings).filter(o => o.planned === date && o.start && o.file.path !== dropped.path)
    .sort((a, b) => hmToMin(a.start) - hmToMin(b.start));
  for (const o of others) {
    const blocks = taskBlocks(o, dflt);
    if (o.status === "done" || !hit(blocks)) { blocks.forEach(g => occupied.push([g.s, g.s + g.dur])); continue; }
    const total = segsTotal(blocks);
    const plan = planInWindow(Math.min(...blocks.map(g => g.s)), total, [...meet, ...occupied], from, to, earliest, limit, slot);
    if (!plan) { blocks.forEach(g => occupied.push([g.s, g.s + g.dur])); continue; }
    plan.forEach(g => occupied.push([g.s, g.s + g.dur]));
    await patchTask(app, o.file, plan.length > 1
      ? { start: minToHm(plan[0].s), estimate: total, segments: fmtSegments(plan) }
      : { start: minToHm(plan[0].s), estimate: total, segments: null });
  }
}

/** New length of one block: a piece of a split task changes its own length, the total follows. */
export async function resizeBlock(plugin: SamayaPlugin, t: Task, seg: number, dur: number) {
  if (t.segments.length > 1) {
    const segs = t.segments.map(g => ({ ...g })); segs[seg].dur = dur;
    await patchTask(plugin.app, t.file, { segments: fmtSegments(segs), estimate: segsTotal(segs) });
  } else await patchTask(plugin.app, t.file, { estimate: dur });
}
