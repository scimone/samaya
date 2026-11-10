// Pure logic of the "Plan my week" guide (no Obsidian imports, unit-tested).
import { addDays, startOfWeek } from "./util";

/** Share of a day's free time that planning should not exceed: the rest is for what nobody can foresee. */
export const BUFFER_SHARE = 0.8;

/** The week to plan: the current one, or the coming one when it is planned on the weekend. */
export function weekToPlan(date: string, dow: number): string {
  const wk = startOfWeek(date);
  return dow === 6 || dow === 0 ? addDays(wk, 7) : wk;
}

/** ok = room to spare, tight = past the buffer, over = more than there is time for. */
export function loadLevel(planned: number, free: number): "ok" | "tight" | "over" {
  if (planned > free) return "over";
  return free > 0 && planned > free * BUFFER_SHARE ? "tight" : "ok";
}

/** Planned work of earlier days, or weekly tasks of earlier weeks, that never got done: the Review step of the week guide. */
export function isLeftover(t: { planned: string; week: string; status: string }, today: string, weekStart: string): boolean {
  if (t.status === "done") return false;
  return t.planned ? t.planned < today : !!t.week && t.week < weekStart;
}
