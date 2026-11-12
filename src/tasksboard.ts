// Pure logic of the Tasks board (no Obsidian imports, unit-tested): which status column a task lands in, and how swimlanes are ordered.
import { addDays } from "./util";

export type Col = "overdue" | "today" | "week" | "later" | "done";
export const BOARD_COLS: Array<[Col, string]> = [["overdue", "Overdue"], ["today", "Today"], ["week", "This week"], ["later", "Later"], ["done", "Done"]];

/**
 * Column of a piece of open work: the `day` it is planned on or, without a day, the `week` (its monday) it was given.
 * null = neither: the work is in the backlog.
 */
export function columnOf(day: string, week: string, td: string, wk: string): Exclude<Col, "done"> | null {
  if (day) return day < td ? "overdue" : day === td ? "today" : day < addDays(wk, 7) ? "week" : "later";
  if (week) return week < wk ? "overdue" : week === wk ? "week" : "later";
  return null;
}

/** A finished task stays on the board for the week it was finished in (tasks finished before the completion date was recorded: by their day). */
export function doneThisWeek(completed: string, planned: string, wk: string): boolean {
  return completed ? completed >= wk : !planned || planned >= wk;
}

export interface Lane<T> { key: string; items: T[]; }
/** Swimlanes of items by `keyOf` ("" = no group, always last); named lanes in the order of `label`. Lanes without items are left out. */
export function lanes<T>(items: T[], keyOf: (t: T) => string, label: (key: string) => string): Lane<T>[] {
  const by = new Map<string, T[]>();
  for (const it of items) { const k = keyOf(it); (by.get(k) ?? by.set(k, []).get(k)!).push(it); }
  return [...by.entries()].map(([key, items]) => ({ key, items }))
    .sort((a, b) => Number(a.key === "") - Number(b.key === "") || label(a.key).localeCompare(label(b.key), undefined, { numeric: true }));
}
