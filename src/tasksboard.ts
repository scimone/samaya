// Pure logic of the Tasks board (no Obsidian imports, unit-tested): which status column a task lands in, and how swimlanes are ordered.
import { Horizon, addDays, bucketOf, horizonOf } from "./util";

/** The board: what is going on now. The backlog: everything else, by when it is due. */
export type Col = "overdue" | "today" | "progress" | "done";
export const BOARD_COLS: Array<[Col, string]> = [["overdue", "Overdue"], ["today", "Today"], ["progress", "In Progress"], ["done", "Done"]];
/** Backlog columns: this week (planned on a later day, or given to the week only), then the parking buckets. */
export type BacklogCol = "thisweek" | Horizon;
export const BACKLOG_COLS: Array<[BacklogCol, string]> = [["thisweek", "This week"], ["week", "Next week"], ["month", "Next month"], ["quarter", "Next quarter"], ["year", "Next year"], ["someday", "Someday"], ["never", "Never"]];

/** Board column of a piece of open work (not started yet): late, or planned for today. null = not on the board: it belongs in the backlog. */
export function columnOf(day: string, week: string, td: string, wk: string): "overdue" | "today" | null {
  if (day) return day < td ? "overdue" : day === td ? "today" : null;
  return week && week < wk ? "overdue" : null;
}

/** Backlog column of a piece of open work: a later day / week gives "This week" or, further out, the bucket its date falls in; parked tasks sit in their bucket. */
export function backlogOf(day: string, week: string, horizon: Horizon | "", later: string, td: string, wk: string): BacklogCol {
  const due = day || week;
  if (due) return due < addDays(wk, 7) ? "thisweek" : horizonOf(due, td);
  return bucketOf(horizon, later, td);
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
