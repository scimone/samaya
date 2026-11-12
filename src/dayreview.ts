// Pure logic for the end-of-day review: how the day was really spent, set against what was planned. No Obsidian imports (unit-tested).

/** Minutes worked on `date` from focus runs written as "2026-11-11 09:05–09:40" (the end carries its date when the run crosses midnight). */
export function runMinutesOn(runs: unknown[], date: string): number {
  let total = 0;
  for (const r of runs) {
    const m = String(r).match(/^\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*[–-]\s*(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})\s*$/);
    if (!m || m[1] !== date) continue;
    const a = +m[2] * 60 + +m[3]; let b = +m[5] * 60 + +m[6];
    if (m[4] && m[4] !== m[1]) b = 1440; // crossed midnight: only the part up to midnight belongs to this day
    if (b > a) total += b - a;
  }
  return total;
}

/** Minutes worked on `date` and later (same run format). */
export function runMinutesFrom(runs: unknown[], date: string): number {
  const days = new Set<string>();
  for (const r of runs) { const m = String(r).match(/^\s*(\d{4}-\d{2}-\d{2})/); if (m && m[1] >= date) days.add(m[1]); }
  let total = 0; for (const d of days) total += runMinutesOn(runs, d);
  return total;
}
/** Minutes worked on the days before `date` (same run format as above). */
export function runMinutesBefore(runs: unknown[], date: string): number {
  const days = new Set<string>();
  for (const r of runs) { const m = String(r).match(/^\s*(\d{4}-\d{2}-\d{2})/); if (m && m[1] < date) days.add(m[1]); }
  let total = 0; for (const d of days) total += runMinutesOn(runs, d);
  return total;
}

export interface ReviewItem {
  title: string; /** it was on the day's plan this morning */ wasPlanned: boolean; /** minutes planned for this day (0 = not planned for the day) */ planned: number; /** minutes actually worked on this day */ actual: number; done: boolean;
  /** ticket key or project name, "" = none */ ticket: string; project: string;
}
export type Grouping = "ticket" | "project";
export interface Row { label: string; planned: number; actual: number; done: boolean; /** tracked, but not planned for the day */ unplanned: boolean; }
export interface GroupRow { label: string; planned: number; actual: number; tasks: number; }

/** One row per task that was planned or worked on, the biggest first. */
export function taskRows(items: ReviewItem[]): Row[] {
  return items.filter(i => i.planned > 0 || i.actual > 0 || i.done).map(i => ({ label: i.title, planned: i.planned, actual: i.actual, done: i.done, unplanned: !i.wasPlanned }))
    .sort((a, b) => Math.max(b.planned, b.actual) - Math.max(a.planned, a.actual) || a.label.localeCompare(b.label));
}
/** Time per ticket or project; what has none is gathered in "No ticket" / "No project" (always last). */
export function groupRows(items: ReviewItem[], by: Grouping): GroupRow[] {
  const none = by === "ticket" ? "No ticket" : "No project"; const m = new Map<string, GroupRow>();
  for (const i of items) {
    if (!i.planned && !i.actual) continue;
    const label = (by === "ticket" ? i.ticket : i.project) || none;
    const g = m.get(label) ?? { label, planned: 0, actual: 0, tasks: 0 }; g.planned += i.planned; g.actual += i.actual; g.tasks++; m.set(label, g);
  }
  return [...m.values()].sort((a, b) => Number(a.label === none) - Number(b.label === none) || Math.max(b.planned, b.actual) - Math.max(a.planned, a.actual) || a.label.localeCompare(b.label));
}
export const hasGroups = (items: ReviewItem[], by: Grouping): boolean => items.some(i => (i.planned || i.actual) && (by === "ticket" ? i.ticket : i.project));

export interface Split { focus: number; meetings: number; breaks: number; other: number; /** the length of the bar: everything above */ total: number; }
/** How the time of the day divides up. Meetings and focus that overlap are not counted twice: what exceeds the worked time is cut from the focus. */
export function daySplit(worked: number, focus: number, meetings: number, breaks: number): Split {
  const w = Math.max(0, worked); const meet = Math.min(Math.max(0, meetings), w); const foc = Math.min(Math.max(0, focus), w - meet);
  const other = Math.max(0, w - meet - foc); const br = Math.max(0, breaks);
  return { focus: foc, meetings: meet, breaks: br, other, total: w + br };
}

/** A short, honest sentence about how the plan went. */
export function verdict(planned: number, actual: number, done: number, count: number): { title: string; text: string } {
  if (!count && !actual) return { title: "A day without a plan", text: "Nothing was planned and no time was tracked." };
  if (!actual) return { title: "No time tracked", text: "Start the focus timer on a task to see how the day really went." };
  if (!planned) return { title: "Unplanned work", text: "You worked, but nothing was planned for today." };
  const r = actual / planned;
  if (r < 0.85) return { title: "Lighter than planned", text: `You tracked ${Math.round(r * 100)}% of the planned task time.` };
  if (r <= 1.15) return { title: "Right on plan", text: `Your tracked time is within ${Math.round(Math.abs(r - 1) * 100)}% of the plan.` };
  return { title: "More than planned", text: `Tasks took ${Math.round((r - 1) * 100)}% longer than estimated.` };
}
