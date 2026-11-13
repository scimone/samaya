// Pure helpers of the journal dashboard: which span of time a note stands for, and how spans are labelled and keyed.
import type { Period } from "./journal";
import { addDays, parseYmd, startOfWeek } from "./util";

/** The date a note stands for: a weekly note parsed to a Sunday belongs to the week that starts the next day. Pure. */
export const anchor = (p: Period, date: string): string => (p === "weekly" && parseYmd(date).getDay() === 0 ? addDays(date, 1) : date);

const quarter = (d: string) => Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;

/** One key per span of time (day, Monday-first week, month, quarter, year): two dates share a key exactly when they are in the same span. `isNote`: the date was parsed from a note's name. Pure. */
export function spanKey(p: Period, date: string, isNote = true): string {
  const a = isNote ? anchor(p, date) : date; // a note's date may need the Sunday shift; a plain calendar date never does
  switch (p) {
    case "daily": return a;
    case "weekly": return startOfWeek(a);
    case "monthly": return a.slice(0, 7);
    case "quarterly": return `${a.slice(0, 4)}-Q${quarter(a)}`;
    case "yearly": return a.slice(0, 4);
  }
}

/** Whether the note's period contains `ref` (YYYY-MM-DD). Pure. */
export const sameSpan = (p: Period, date: string, ref: string): boolean => spanKey(p, date) === spanKey(p, ref, false);

/** The first day of the span containing `date`: what a new note of that span is created for. Pure. */
export function spanStart(p: Period, date: string): string {
  switch (p) {
    case "daily": return date;
    case "weekly": return startOfWeek(date);
    case "monthly": return date.slice(0, 7) + "-01";
    case "quarterly": return `${date.slice(0, 4)}-${String((quarter(date) - 1) * 3 + 1).padStart(2, "0")}-01`;
    case "yearly": return date.slice(0, 4) + "-01-01";
  }
}

/** Label and a quieter second line, e.g. "Thu 12 Nov", "Week 46" over its dates. `weekNo` and `range` are passed in to keep this free of the heading code. Pure. */
export function rowLabel(p: Period, date: string, weekNo: (d: string) => number, range: (weekStart: string) => string): { main: string; sub: string } {
  const a = anchor(p, date); const d = parseYmd(a);
  switch (p) {
    case "daily": return { main: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), sub: d.getFullYear() === new Date().getFullYear() ? "" : String(d.getFullYear()) };
    case "weekly": return { main: `Week ${weekNo(a)}`, sub: range(startOfWeek(a)) };
    case "monthly": return { main: d.toLocaleDateString(undefined, { month: "long" }), sub: String(d.getFullYear()) };
    case "quarterly": return { main: `Q${quarter(a)}`, sub: String(d.getFullYear()) };
    case "yearly": return { main: String(d.getFullYear()), sub: "" };
  }
}
