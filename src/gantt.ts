// Pure Gantt chart maths: date ranges, month marks, dragging. No Obsidian imports (unit-tested).
import { addDays, parseYmd, startOfWeek } from "./util";

export interface Span { start: string; end: string; }
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const daysBetween = (a: string, b: string): number => Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);

/** A project's dates from raw frontmatter values; null when it has no (valid) start. A missing or earlier end becomes the start. */
export function parseSpan(start: unknown, end: unknown): Span | null {
  const s = String(start ?? "").slice(0, 10), e = String(end ?? "").slice(0, 10);
  if (!YMD.test(s)) return null;
  return { start: s, end: YMD.test(e) && e >= s ? e : s };
}

/** The chart's first day (a Monday) and number of days (whole weeks): everything plus a margin, always including today. */
export function ganttRange(spans: Span[], today: string, extraBackWeeks = 0, extraFwdWeeks = 0): { from: string; days: number } {
  const all = [today, ...spans.flatMap(s => [s.start, s.end])].sort();
  const from = startOfWeek(addDays(all[0], -7 - extraBackWeeks * 7));
  const weeks = Math.ceil((daysBetween(from, addDays(all[all.length - 1], 21 + extraFwdWeeks * 7)) + 1) / 7);
  return { from, days: weeks * 7 };
}

/** Month headings across the range: first-day offset and length in days. */
export function monthMarks(from: string, days: number): Array<{ date: Date; offset: number; span: number }> {
  const out: Array<{ date: Date; offset: number; span: number }> = [];
  const f = parseYmd(from);
  for (let i = 0; i < days; i++) {
    const d = new Date(f.getFullYear(), f.getMonth(), f.getDate() + i);
    const last = out[out.length - 1];
    if (!last || d.getDate() === 1) out.push({ date: d, offset: i, span: 1 }); else last.span++;
  }
  return out;
}

export type DragMode = "move" | "start" | "end";
/** The span after dragging by `delta` days. Resizing never makes it shorter than one day. */
export function dragSpan(span: Span, mode: DragMode, delta: number): Span {
  if (mode === "move") return { start: addDays(span.start, delta), end: addDays(span.end, delta) };
  if (mode === "start") { const s = addDays(span.start, delta); return { start: s > span.end ? span.end : s, end: span.end }; }
  const e = addDays(span.end, delta); return { start: span.start, end: e < span.start ? span.start : e };
}

export type Granularity = "month" | "quarter" | "year";
export const GRANULARITIES: Granularity[] = ["month", "quarter", "year"];
/** Pixels per day. Month and quarter fit ~30 / ~91 days into `avail` px; year uses a fixed narrow width (scrolls). */
export function granularityDayWidth(g: Granularity, avail: number): number {
  const fit = (n: number, min: number) => Math.max(min, Math.floor((avail > 0 ? avail : 900) / n * 10) / 10);
  return g === "month" ? fit(30.5, 14) : g === "quarter" ? fit(91.5, 5) : 4;
}

/** A task's bar: first to last planned day (several pieces span everything in between); null when it has no day. */
export function taskSpan(dates: string[]): Span | null {
  const ds = dates.filter(d => YMD.test(d)).sort();
  return ds.length ? { start: ds[0], end: ds[ds.length - 1] } : null;
}

/** Rows to show for `n` tasks: all of them up to `max`; beyond that the first and last `edge`, with a `gap` of hidden ones between (unless `expanded`). */
export function collapseTasks(n: number, expanded: boolean, max = 6, edge = 3): { head: number; gap: number; tail: number } {
  if (n <= max || expanded) return { head: n, gap: 0, tail: 0 };
  return { head: edge, gap: n - 2 * edge, tail: edge };
}
