// Pure work-time logic: workday log, breaks, capacity, weekly balance. No Obsidian imports (unit-tested).
import { addDays, hmToMin, minToHm, parseYmd, startOfWeek, ymd } from "./util";

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
/** Free capacity inside the working window [from, to] (minutes of the day): window - lunch - calendar meetings (overlaps counted once, lunch overlap not double-counted). */
export function capacityWindow(from: number, to: number, lunch: [number, number], meetings: Array<[number, number]>): Capacity {
  const total = Math.max(0, to - from);
  const l: [number, number] = [Math.max(lunch[0], from), Math.min(lunch[1], to)]; const lunchLen = Math.max(0, l[1] - l[0]);
  const clipped = meetings.map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)]);
  const meet = Math.max(0, unionMinutes([...clipped, l]) - lunchLen);
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

export type PeriodKind = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
/** First and last day (YYYY-MM-DD) of the period containing `date`. */
export function periodRange(kind: PeriodKind, date: string): { from: string; to: string } {
  const [y, m] = date.split("-").map(Number); const pad2 = (n: number) => String(n).padStart(2, "0");
  const lastDay = (yy: number, mm: number) => new Date(yy, mm, 0).getDate(); // mm: 1-12
  switch (kind) {
    case "daily": return { from: date, to: date };
    case "weekly": { const from = startOfWeek(date); return { from, to: addDays(from, 6) }; }
    case "monthly": return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(lastDay(y, m))}` };
    case "quarterly": { const q0 = Math.floor((m - 1) / 3) * 3 + 1; return { from: `${y}-${pad2(q0)}-01`, to: `${y}-${pad2(q0 + 2)}-${pad2(lastDay(y, q0 + 2))}` }; }
    default: return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
}
export interface PeriodStats { days: number; avgStart: string | null; avgEnd: string | null; worked: number; avgWorked: number; target: number; balance: number; }
/** Aggregates over the finished days (start and end logged) between from and to: averages, totals and overtime (worked - required). */
export function periodStats(logs: DayLog[], from: string, to: string, weeklyHours: number, workdays: number): PeriodStats {
  const done = logs.filter(l => l.start && l.end && l.date >= from && l.date <= to);
  const n = done.length; if (!n) return { days: 0, avgStart: null, avgEnd: null, worked: 0, avgWorked: 0, target: 0, balance: 0 };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const worked = done.reduce((a, l) => a + workedMinutes(l, 1440), 0);
  const target = done.reduce((a, l) => a + dailyTarget(weeklyHours, workdays, l.date), 0);
  return { days: n, avgStart: minToHm(mean(done.map(l => hmToMin(l.start!)))), avgEnd: minToHm(mean(done.map(l => hmToMin(l.end!)))), worked, avgWorked: worked / n, target, balance: worked - target };
}

/** Dates (YYYY-MM-DD) covered by all-day events whose title contains `keyword` (case-insensitive; empty keyword = none). The event's end is exclusive. */
export function vacationDates(events: Array<{ title: string; start: Date; end: Date; allDay: boolean }>, keyword: string): Set<string> {
  const out = new Set<string>(); const k = keyword.trim().toLowerCase(); if (!k) return out;
  for (const e of events) {
    if (!e.allDay || !e.title.toLowerCase().includes(k)) continue;
    const last = ymd(e.end) > ymd(e.start) ? addDays(ymd(e.end), -1) : ymd(e.start);
    for (let d = ymd(e.start); d <= last; d = addDays(d, 1)) out.add(d);
  }
  return out;
}
/** Average worked minutes per finished day of the week's working days (the first `workdays` days from Monday), leaving out vacation days and days without a finished log. */
export function weekAverageWorked(logs: DayLog[], weekStart: string, workdays: number, vacation: Set<string>): { avg: number; days: number } | null {
  const mins: number[] = [];
  for (let i = 0; i < Math.max(1, Math.min(7, Math.round(workdays))); i++) {
    const date = addDays(weekStart, i); if (vacation.has(date)) continue;
    const l = logs.find(x => x.date === date); if (l && l.start && l.end) mins.push(workedMinutes(l, 1440));
  }
  return mins.length ? { avg: mins.reduce((a, b) => a + b, 0) / mins.length, days: mins.length } : null;
}
