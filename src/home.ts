// Home page logic that does not touch the DOM (so it can be tested).

/** What the day is asking for right now; the Home hero card changes with it. */
export type Moment = "morning" | "working" | "break" | "wrapup" | "done";

export interface MomentInput {
  started: boolean; ended: boolean; onBreak: boolean;
  /** minutes since midnight */ now: number; /** shutdown reminder, minutes since midnight */ shutdown: number;
  /** open (not done) tasks planned for today */ open: number; /** all tasks planned for today */ total: number;
}

export function pickMoment(i: MomentInput): Moment {
  if (i.ended) return "done";
  if (!i.started) return "morning";
  if (i.onBreak) return "break";
  if (i.now >= i.shutdown || (i.total > 0 && i.open === 0)) return "wrapup";
  return "working";
}

export function greeting(hour: number): string {
  return hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** Which weekly ritual fits now: plan around the turn of the week, review at its end. dow: 0 = Sunday. */
export function weekIntent(dow: number, hour: number): "plan" | "review" | null {
  if (dow === 5 && hour >= 14) return "review";
  if (dow === 6 || dow === 0 || dow === 1) return "plan";
  return null;
}

/** "in 25m" / "in 1h 5m" / "now" for a start time `min` minutes away. */
export function inMinutes(min: number): string {
  if (min <= 0) return "now";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return "in " + (h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`);
}
