// Pure logic of the "Plan my week" guide (no Obsidian imports, unit-tested).
import { addDays, startOfWeek } from "./util";

/** Share of a day's free time that planning should not exceed: the rest is for what nobody can foresee. */
export const BUFFER_SHARE = 0.8;
/** The share of the free time that may be planned, from the "free buffer" setting in percent (20 -> 0.8). */
export function bufferShare(bufferPercent: number | undefined): number {
  const p = typeof bufferPercent === "number" && isFinite(bufferPercent) ? Math.min(90, Math.max(0, bufferPercent)) : 20;
  return (100 - p) / 100;
}

/** The week to plan: the current one, or the coming one when it is planned on the weekend. */
export function weekToPlan(date: string, dow: number): string {
  const wk = startOfWeek(date);
  return dow === 6 || dow === 0 ? addDays(wk, 7) : wk;
}

/** ok = room to spare, tight = past the buffer, over = more than there is time for. */
export function loadLevel(planned: number, free: number, share = BUFFER_SHARE): "ok" | "tight" | "over" {
  if (planned > free) return "over";
  return free > 0 && planned > free * share ? "tight" : "ok";
}

/** Planned work of earlier days, or weekly tasks of earlier weeks, that never got done: the Review step of the week guide. */
export function isLeftover(t: { planned: string; week: string; status: string }, today: string, weekStart: string): boolean {
  if (t.status === "done") return false;
  return t.planned ? t.planned < today : !!t.week && t.week < weekStart;
}

export const WEEK_STEP = { review: 0, tickets: 1, backlog: 2, schedule: 3, check: 4 } as const;
/** The steps of the week guide that take part: Review only with left over tasks, Tickets only when there are tickets. */
export function weekSteps(review: boolean, tickets: boolean): number[] {
  return [WEEK_STEP.review, WEEK_STEP.tickets, WEEK_STEP.backlog, WEEK_STEP.schedule, WEEK_STEP.check].filter(i => (i === WEEK_STEP.review ? review : i === WEEK_STEP.tickets ? tickets : true));
}

/** How the whole week looks: the worst of its days. `over` / `tight` count the days. */
export function weekVerdict(days: Array<{ planned: number; free: number }>, share = BUFFER_SHARE): { level: "ok" | "tight" | "over"; over: number; tight: number } {
  const lv = days.map(d => loadLevel(d.planned, d.free, share));
  const over = lv.filter(l => l === "over").length, tight = lv.filter(l => l === "tight").length;
  return { level: over ? "over" : tight ? "tight" : "ok", over, tight };
}
/** Minutes to take off a day to be back inside the buffer (0 when it already is). */
export function trimToBuffer(planned: number, free: number, share = BUFFER_SHARE): number { return Math.max(0, Math.round(planned - free * share)); }

/** Shape of a capacity bar whose scale is the plannable time plus the meetings (the work time without lunch): the meetings first, then the tasks,
 *  and the mark where the recommended share of the free time ends. All values are percent of the bar. */
export function capBarShape(tasks: number, meetings: number, free: number, share = BUFFER_SHARE): { meet: number; task: number; mark: number | null } {
  const total = free + meetings;
  if (total <= 0) return { meet: 0, task: tasks > 0 ? 100 : 0, mark: null };
  const pct = (m: number) => Math.min(100, Math.max(0, (m / total) * 100));
  return { meet: pct(meetings), task: pct(Math.min(tasks, free)), mark: free > 0 ? pct(meetings + free * share) : null };
}
