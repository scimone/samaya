import type SamayaPlugin from "../main";
import type { IcsEvent } from "../ics";
import { Task, patchTask, readTask } from "../model";
import { MergeSegmentsModal } from "../modals";
import { Seg, fmtSegments, mergeOffer, planSegments, segsTotal } from "../segments";
import { hmToMin, minToHm, parseYmd } from "../util";
import type { TFile } from "obsidian";

/** Meetings and lunch of a day as [start, end] minutes: what a task flows around. */
export function busyIntervals(plugin: SamayaPlugin, date: string, events: IcsEvent[]): Array<[number, number]> {
  const dayMs = parseYmd(date).getTime();
  const iv = events.filter(e => !e.allDay).map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]);
  iv.push(plugin.lunchFor(date)); return iv;
}

/** The blocks a task occupies on the timeline: its segments, or one block from `start` with the estimate. */
export function taskBlocks(t: Task, dflt: number): Seg[] {
  return t.segments.length > 1 ? t.segments : [{ s: hmToMin(t.start), dur: t.estimate || dflt }];
}
/** Length of what is being dragged: one segment, or the whole task. */
export function dragDur(t: Task | undefined, seg: number | null, dflt: number): number {
  if (!t) return dflt; return seg !== null && t.segments[seg] ? t.segments[seg].dur : t.estimate || dflt;
}

/** Marks the pieces of a split task and lights up all of them while one is hovered. */
export function decorateSegment(b: HTMLElement, t: Task, k: number, n: number, scope: HTMLElement) {
  if (n < 2) return;
  b.addClass("is-split"); b.dataset.seg = String(k); b.dataset.task = t.file.path;
  const all = () => Array.from(scope.querySelectorAll<HTMLElement>(".samaya-block.is-split")).filter(x => x.dataset.task === t.file.path);
  b.addEventListener("mouseenter", () => all().forEach(x => x.addClass("is-linked")));
  b.addEventListener("mouseleave", () => all().forEach(x => x.removeClass("is-linked")));
}
export const segLabel = (k: number, n: number): string => (n > 1 ? ` · ${k + 1}/${n}` : "");

/**
 * Drop on the timeline at `startMin`. A task flows around meetings and lunch (split into segments); a dragged segment of a
 * split task only moves itself, and offers to merge when the pieces fit together again.
 */
export async function dropOnTimeline(plugin: SamayaPlugin, file: TFile, date: string, startMin: number, seg: number | null, events: IcsEvent[], limit: number, slot: number) {
  const app = plugin.app; const t = readTask(app, file); const dflt = plugin.settings.defaultEstimate;
  const base = { planned: date, week: null };
  const single = (at: number, dur: number) => patchTask(app, file, { ...base, start: minToHm(at), estimate: dur, segments: null });
  const split = (segs: Seg[]) => patchTask(app, file, { ...base, start: minToHm(segs[0].s), estimate: segsTotal(segs), segments: fmtSegments(segs) });
  const busy = busyIntervals(plugin, date, events);
  if (seg !== null && t.segments.length > 1) {
    const segs = t.segments.map(g => ({ ...g })); const moved = segs[seg]; moved.s = startMin; segs.sort((a, b) => a.s - b.s);
    const offer = mergeOffer(segs, segs.indexOf(moved), busy, limit);
    if (offer) { const total = segsTotal(segs); new MergeSegmentsModal(plugin, total, merge => { void (merge ? single(offer.at, total) : split(segs)); }).open(); return; }
    await split(segs); return;
  }
  const dur = t.estimate || dflt;
  const plan = planSegments(startMin, dur, busy, limit, slot);
  if (plan && plan.length > 1) await split(plan); else await single(plan ? plan[0].s : startMin, dur);
}

/** New length of one block: a piece of a split task changes its own length, the total follows. */
export async function resizeBlock(plugin: SamayaPlugin, t: Task, seg: number, dur: number) {
  if (t.segments.length > 1) {
    const segs = t.segments.map(g => ({ ...g })); segs[seg].dur = dur;
    await patchTask(plugin.app, t.file, { segments: fmtSegments(segs), estimate: segsTotal(segs) });
  } else await patchTask(plugin.app, t.file, { estimate: dur });
}
