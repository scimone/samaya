// Pure month-calendar maths for the journal calendar (weeks start on Monday, ISO week numbers). No Obsidian imports.
import { addDays, parseYmd, ymd } from "./util";

/** ISO 8601 week number (1-53) of a YYYY-MM-DD date. */
export function isoWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); // the Thursday of this week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
}

export interface GridDay { date: string; inMonth: boolean; }
export interface GridWeek { week: number; start: string; days: GridDay[]; }
/** Six Monday-first weeks covering the month (month0: 0 = January). */
export function monthGrid(year: number, month0: number): GridWeek[] {
  const first = new Date(year, month0, 1);
  const start = ymd(new Date(year, month0, 1 - ((first.getDay() + 6) % 7)));
  return Array.from({ length: 6 }, (_, w) => {
    const ws = addDays(start, w * 7);
    return { week: isoWeek(ws), start: ws, days: Array.from({ length: 7 }, (_, i) => { const date = addDays(ws, i); return { date, inMonth: parseYmd(date).getMonth() === month0 }; }) };
  });
}
