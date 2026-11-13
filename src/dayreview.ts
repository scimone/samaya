// Pure logic for the end-of-day review: how the day was really spent, set against what was planned. No Obsidian imports (unit-tested).

export interface Span { s: number; e: number; }
/** The focus runs of `date` as time spans (minutes of the day), from runs written as "2026-11-11 09:05–09:40" (the end carries its date when the run crosses midnight). */
export function runSpansOn(runs: unknown[], date: string): Span[] {
  const out: Span[] = [];
  for (const r of runs) {
    const m = String(r).match(/^\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*[–-]\s*(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})\s*$/);
    if (!m || m[1] !== date) continue;
    const a = +m[2] * 60 + +m[3]; let b = +m[5] * 60 + +m[6];
    if (m[4] && m[4] !== m[1]) b = 1440; // crossed midnight: only the part up to midnight belongs to this day
    if (b > a) out.push({ s: a, e: b });
  }
  return out.sort((x, y) => x.s - y.s);
}
/** Minutes worked on `date` from focus runs. */
export const runMinutesOn = (runs: unknown[], date: string): number => runSpansOn(runs, date).reduce((a, g) => a + (g.e - g.s), 0);

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
  key: string; title: string; /** it was on the day's plan this morning */ wasPlanned: boolean; /** minutes planned for this day (0 = not planned for the day) */ planned: number; /** minutes actually worked on this day */ actual: number; done: boolean;
  /** the time slots it had on the plan, and the focus runs it really got (minutes of the day) */ slots: Span[]; spans: Span[];
  /** ticket key or project name, "" = none */ ticket: string; project: string;
}
export type Grouping = "ticket" | "project";
/** How a task's day differs from its plan. */
export type Change = "added" | "skipped" | "open" | "over" | "under" | "moved";
export interface Row {
  key: string; label: string; planned: number; actual: number; done: boolean; /** tracked or checked off, but not planned for the day */ unplanned: boolean;
  /** planned / actual start (minutes of the day), null = no time */ plannedAt: number | null; actualAt: number | null; changes: Change[];
}
export interface GroupRow { label: string; planned: number; actual: number; tasks: number; done: number; added: number; }

/** Moving a task by this much counts as a difference; so does a gap of this size between planned and tracked time (and 10%). */
export const MOVED_MIN = 30, GAP_MIN = 5;
/** What differs between the plan and the day for one task. A planned task that was neither worked on nor checked off was skipped. */
export function changesOf(i: ReviewItem): Change[] {
  if (!i.wasPlanned) return ["added"];
  const c: Change[] = []; const at = i.slots[0]?.s ?? null; const was = i.spans[0]?.s ?? null;
  if (!i.actual && !i.done) return ["skipped"];
  if (i.actual && i.planned) {
    const d = i.actual - i.planned;
    if (d >= GAP_MIN && i.actual > i.planned * 1.1) c.push("over"); else if (d <= -GAP_MIN && i.actual < i.planned * 0.9) c.push("under");
  }
  if (at !== null && was !== null && Math.abs(was - at) >= MOVED_MIN) c.push("moved");
  if (!i.done) c.push("open");
  return c;
}
/** One row per task that was planned, worked on or checked off: in the order of the day, the changes first. */
export function taskRows(items: ReviewItem[]): Row[] {
  return items.filter(i => i.planned > 0 || i.actual > 0 || i.done || i.wasPlanned).map((i): Row => ({
    key: i.key, label: i.title, planned: i.planned, actual: i.actual, done: i.done, unplanned: !i.wasPlanned,
    plannedAt: i.slots[0]?.s ?? null, actualAt: i.spans[0]?.s ?? null, changes: changesOf(i),
  })).sort((a, b) => Number(!a.changes.length) - Number(!b.changes.length) || (a.plannedAt ?? a.actualAt ?? 1e9) - (b.plannedAt ?? b.actualAt ?? 1e9) || a.label.localeCompare(b.label));
}
/** Time per ticket or project, and how much of it got done; what has none is gathered in "No ticket" / "No project" (always last). */
export function groupRows(items: ReviewItem[], by: Grouping): GroupRow[] {
  const none = by === "ticket" ? "No ticket" : "No project"; const m = new Map<string, GroupRow>();
  for (const i of items) {
    if (!i.planned && !i.actual && !i.done) continue;
    const label = (by === "ticket" ? i.ticket : i.project) || none;
    const g = m.get(label) ?? { label, planned: 0, actual: 0, tasks: 0, done: 0, added: 0 };
    g.planned += i.planned; g.actual += i.actual; g.tasks++; if (i.done) g.done++; if (!i.wasPlanned) g.added++; m.set(label, g);
  }
  return [...m.values()].sort((a, b) => Number(a.label === none) - Number(b.label === none) || Math.max(b.planned, b.actual) - Math.max(a.planned, a.actual) || a.label.localeCompare(b.label));
}
export const hasGroups = (items: ReviewItem[], by: Grouping): boolean => items.some(i => (i.planned || i.actual || i.done) && (by === "ticket" ? i.ticket : i.project));

/** The hours the timeline compare shows: everything that happened or was planned, rounded out to whole hours, at least `min` hours long. */
export function hourRange(points: number[], min = 6): [number, number] {
  const p = points.filter(x => isFinite(x)); if (!p.length) return [8, 8 + min];
  let a = Math.floor(Math.min(...p) / 60), b = Math.ceil(Math.max(...p) / 60);
  while (b - a < min) { if (a > 0) a--; if (b - a < min && b < 24) b++; if (a <= 0 && b >= 24) break; }
  return [Math.max(0, a), Math.min(24, b)];
}
/** "+20m" / "−1h 5m" / "" for no difference; `fmt` writes the length. */
export const signed = (d: number, fmt: (m: number) => string): string => (Math.abs(d) < 1 ? "" : (d > 0 ? "+" : "−") + fmt(Math.abs(d)));

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
