// Pure work-time logic: workday log, breaks, capacity, weekly balance. No Obsidian imports (unit-tested).
import { addDays, hmToMin, minToHm, parseYmd } from "./util";

export type BreakKind = "lunch" | "break";
export interface Break { start: string; end: string; kind: BreakKind; }
export interface DayLog {
  date: string; start: string | null; end: string | null; breaks: Break[];
  open: { start: string; kind: BreakKind } | null;
  /** last time we saw activity (HH:mm); used to close a day the user forgot to end */ seen?: string;
  endAuto?: boolean;
}

export const fmtBreak = (b: Break): string => `${b.start}-${b.end}${b.kind !== "break" ? " " + b.kind : ""}`;
export function parseBreak(raw: unknown): Break | null {
  const m = String(raw).match(/^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s+(lunch|idle|break))?\s*$/);
  return m ? { start: minToHm(hmToMin(m[1])), end: minToHm(hmToMin(m[2])), kind: m[3] === "lunch" ? "lunch" : "break" } : null;
}

export function breakMinutes(log: DayLog, nowMin?: number): number {
  let sum = log.breaks.reduce((a, b) => a + Math.max(0, hmToMin(b.end) - hmToMin(b.start)), 0);
  if (log.open && nowMin !== undefined) sum += Math.max(0, nowMin - hmToMin(log.open.start));
  return sum;
}
export function workedMinutes(log: DayLog | null, nowMin: number): number {
  if (!log || !log.start) return 0;
  const end = log.end ? hmToMin(log.end) : nowMin;
  return Math.max(0, end - hmToMin(log.start) - breakMinutes(log, log.end ? undefined : nowMin));
}

/** Target minutes for a date: weeklyHours spread over the first `workdays` days of the week (Mon..). */
export function dailyTarget(weeklyHours: number, workdays: number, date: string): number {
  const dow = parseYmd(date).getDay() || 7; // Mon=1 .. Sun=7
  const n = Math.max(1, Math.min(7, Math.round(workdays)));
  return dow <= n ? Math.round((weeklyHours * 60) / n) : 0;
}

export function unionMinutes(iv: Array<[number, number]>): number {
  const s = iv.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]); let total = 0, cur: [number, number] | null = null;
  for (const [a, b] of s) { if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b); else { if (cur) total += cur[1] - cur[0]; cur = [a, b]; } }
  return total + (cur ? cur[1] - cur[0] : 0);
}
export interface Capacity { total: number; lunch: number; meetings: number; free: number; }
/** capacity = total hours - lunch break - calendar meetings (overlaps counted once, lunch overlap not double-counted) */
export function capacityMinutes(capacityHours: number, lunch: [number, number], meetings: Array<[number, number]>): Capacity {
  const total = Math.round(capacityHours * 60); const lunchLen = Math.max(0, lunch[1] - lunch[0]);
  const clipped = meetings.map(([a, b]): [number, number] => [Math.max(a, 0), Math.min(b, 1440)]);
  const meet = Math.max(0, unionMinutes([...clipped, lunch]) - lunchLen);
  return { total, lunch: lunchLen, meetings: meet, free: Math.max(0, total - lunchLen - meet) };
}

/** If the day spans the lunch window and nothing covers at least half of it, return the default lunch as a break. */
export function autoLunch(log: DayLog, lunch: [number, number]): Break | null {
  if (!log.start || !log.end) return null;
  if (hmToMin(log.start) > lunch[0] || hmToMin(log.end) < lunch[1]) return null;
  const covered = unionMinutes(log.breaks.map((b): [number, number] => [Math.max(hmToMin(b.start), lunch[0]), Math.min(hmToMin(b.end), lunch[1])]));
  if (log.breaks.some(b => b.kind === "lunch") || covered * 2 >= lunch[1] - lunch[0]) return null;
  return { start: minToHm(lunch[0]), end: minToHm(lunch[1]), kind: "lunch" };
}

export interface WeekRow { date: string; log: DayLog | null; worked: number; target: number; delta: number | null; isToday: boolean; }
export interface WeekSummary { rows: WeekRow[]; worked: number; target: number; balance: number; }
/** `balance` = sum of (worked - target) over finished days of this week (today only once ended). */
export function weekSummary(logs: DayLog[], weekStart: string, weeklyHours: number, workdays: number, today: string, nowMin: number): WeekSummary {
  const byDate = new Map(logs.map(l => [l.date, l])); const rows: WeekRow[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i); const log = byDate.get(date) ?? null;
    const target = dailyTarget(weeklyHours, workdays, date); const live = date === today && !!log && !log.end;
    const worked = workedMinutes(log, date === today ? nowMin : 1440);
    rows.push({ date, log, worked, target, delta: log && !live ? worked - target : null, isToday: date === today });
  }
  return { rows, worked: rows.reduce((a, r) => a + r.worked, 0), target: rows.reduce((a, r) => a + r.target, 0), balance: rows.reduce((a, r) => a + (r.delta ?? 0), 0) };
}
/** Running overtime balance over all finished days. */
export function totalBalance(logs: DayLog[], weeklyHours: number, workdays: number): number {
  return logs.filter(l => l.start && l.end).reduce((a, l) => a + workedMinutes(l, 1440) - dailyTarget(weeklyHours, workdays, l.date), 0);
}
export function fmtSigned(min: number): string {
  const sign = min < 0 ? "-" : "+"; const m = Math.abs(Math.round(min));
  return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
