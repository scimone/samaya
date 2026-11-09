// Pure logic for split tasks: one task, several time segments on the timeline. No Obsidian imports (unit-tested).
import { hmToMin, minToHm } from "./util";

export interface Seg { s: number; dur: number; }

/** Frontmatter list like ["10:15-11:00", "13:00-13:45"] -> segments sorted by start (invalid entries dropped). */
export function parseSegments(raw: unknown): Seg[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Seg[] = [];
  for (const x of list) {
    const m = String(x).match(/^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/); if (!m) continue;
    const s = hmToMin(m[1]), e = hmToMin(m[2]); if (e > s) out.push({ s, dur: e - s });
  }
  return out.sort((a, b) => a.s - b.s);
}
export const fmtSegments = (segs: Seg[]): string[] => segs.map(g => `${minToHm(g.s)}-${minToHm(g.s + g.dur)}`);
export const segsTotal = (segs: Seg[]): number => segs.reduce((a, g) => a + g.dur, 0);

/** Merge overlapping or touching intervals. */
export function mergeBusy(busy: Array<[number, number]>): Array<[number, number]> {
  const iv = busy.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]); const out: Array<[number, number]> = [];
  for (const [a, b] of iv) { const last = out[out.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}

/**
 * Place `dur` minutes starting at `start`, flowing around busy intervals (meetings, lunch):
 * the part before a conflict fills the open gap, the rest continues right after it.
 * A start inside a busy interval moves to its end; gaps shorter than `minSeg` are skipped.
 * Returns null when the task does not fit before `limit`.
 */
export function planSegments(start: number, dur: number, busy: Array<[number, number]>, limit: number, minSeg: number): Seg[] | null {
  const bz = mergeBusy(busy); const out: Seg[] = []; let t = start, left = dur;
  for (let guard = 0; guard < 100 && left > 0; guard++) {
    const inside = bz.find(([a, b]) => t >= a && t < b); if (inside) t = inside[1];
    const next = bz.find(([a]) => a > t); const room = next ? next[0] - t : Infinity;
    if (room >= left) { out.push({ s: t, dur: left }); left = 0; break; }
    if (room >= minSeg) { out.push({ s: t, dur: room }); left -= room; }
    t = next![1];
  }
  if (left > 0) return null;
  const last = out[out.length - 1]; return last.s + last.dur > limit ? null : out;
}

/**
 * After segment `idx` of a split task was moved: offer to merge when it touches or overlaps another segment,
 * or when it now sits in an open block big enough for the whole task. Returns where the merged block starts.
 */
export function mergeOffer(segs: Seg[], idx: number, busy: Array<[number, number]>, limit: number): { at: number } | null {
  if (segs.length < 2) return null;
  const m = segs[idx];
  const near = segs.filter((o, i) => i !== idx && m.s <= o.s + o.dur && o.s <= m.s + m.dur);
  if (near.length) return { at: Math.min(m.s, ...near.map(o => o.s)) };
  const total = segsTotal(segs);
  if (m.s + total <= limit && !mergeBusy(busy).some(([a, b]) => a < m.s + total && b > m.s)) return { at: m.s };
  return null;
}
