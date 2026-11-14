// Pure logic for the planned pieces ("sessions") of a task, on any day. No Obsidian imports (unit-tested).
//
// A task is planned as a list of sessions. Each one is a piece of work on one day, with a time (`s`, minutes since midnight)
// or without one (`s` null: it is on the day's list, not yet on the timeline). A task whose estimate is not fully scheduled
// has a "rest": minutes that live in this week's list or in the backlog until they get a day.
import { hmToMin, minToHm } from "./util";

export interface Session { date: string; /** start in minutes, null = no time slot yet */ s: number | null; dur: number; }
export interface Piece { s: number | null; dur: number; }

const RE = /^\s*(\d{4}-\d{2}-\d{2})(?:\s+(?:(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})|(\d+)\s*m))?\s*$/;

/** "2026-11-11 13:00-14:00", "2026-11-12 90m" (a piece without a time) or "2026-11-11" (the whole estimate, no time; dur 0 until resolved). */
export function parseSession(x: unknown): Session | null {
  const m = String(x).match(RE); if (!m) return null;
  if (m[2]) { const s = hmToMin(m[2]), e = hmToMin(m[3]); return e > s ? { date: m[1], s, dur: e - s } : null; }
  return { date: m[1], s: null, dur: m[4] ? Number(m[4]) : 0 };
}
export function formatSession(g: Session): string {
  if (g.s !== null) { const e = g.s + g.dur; return `${g.date} ${minToHm(g.s)}-${e >= 1440 ? "24:00" : minToHm(e)}`; } // a block may end at midnight: 24:00, not 23:59
  return g.dur > 0 ? `${g.date} ${g.dur}m` : g.date;
}
/** By day, then by time (a piece without a time after the timed ones). */
export const sortSessions = (ss: Session[]): Session[] => [...ss].sort((a, b) => a.date.localeCompare(b.date) || (a.s ?? 1e9) - (b.s ?? 1e9));
export function parseSessionList(raw: unknown): Session[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return sortSessions(list.map(parseSession).filter((g): g is Session => !!g));
}
/** A day without a length ("2026-11-11") stands for what is left of the estimate once the other pieces are counted. */
export function resolveSessions(ss: Session[], estimate: number): Session[] {
  const known = ss.reduce((a, g) => a + g.dur, 0);
  let left = Math.max(0, estimate - known);
  return ss.map(g => { if (g.dur > 0 || g.s !== null) return g; const d = left; left = 0; return { ...g, dur: d }; });
}

export const sessionsTotal = (ss: Session[]): number => ss.reduce((a, g) => a + g.dur, 0);
export const sessionDays = (ss: Session[]): string[] => Array.from(new Set(ss.map(g => g.date))).sort();
export const dayPieces = (ss: Session[], date: string): Session[] => ss.filter(g => g.date === date);
export const dayMinutes = (ss: Session[], date: string): number => sessionsTotal(dayPieces(ss, date));
/** Pieces that do not sit on `date`. */
export const withoutDay = (ss: Session[], date: string): Session[] => ss.filter(g => g.date !== date);

/** Replace everything on `date` by `pieces`. */
export function replaceDay(ss: Session[], date: string, pieces: Piece[]): Session[] {
  return sortSessions([...withoutDay(ss, date), ...pieces.filter(p => p.dur > 0).map(p => ({ date, s: p.s, dur: p.dur }))]);
}
/** Add minutes to a day. A day that already has pieces becomes one piece without a time (the old slots no longer fit together). */
export function addMinutes(ss: Session[], date: string, mins: number): Session[] {
  if (mins <= 0) return ss;
  const there = dayPieces(ss, date);
  return replaceDay(ss, date, [{ s: null, dur: sessionsTotal(there) + mins }]);
}
/** Take the piece `k` (index among the day's pieces) off a day, or all of them (k null). */
export function takePiece(ss: Session[], date: string, k: number | null): { left: Session[]; mins: number } {
  const there = dayPieces(ss, date);
  const gone = k !== null && there[k] ? [there[k]] : there;
  return { left: ss.filter(g => !gone.includes(g)), mins: sessionsTotal(gone) };
}
/** Cut a piece into a first part of `first` minutes (same place) and the minutes left over. Null when the cut does not leave two parts. */
export function splitPiece(ss: Session[], date: string, k: number | null, first: number): { sessions: Session[]; left: number; at: number | null } | null {
  const there = dayPieces(ss, date); const p = there[k ?? 0]; if (!p || first <= 0 || first >= p.dur) return null;
  const head: Session = { ...p, dur: first };
  return { sessions: sortSessions([...ss.filter(g => g !== p), head]), left: p.dur - first, at: p.s === null ? null : p.s + first };
}

/** Length of what is dragged: the minutes of the rest (fromDay ""), one piece of a day, a whole day, or the task's estimate when it has no pieces. */
export function pieceLength(ss: Session[], rest: number, estimate: number, fromDay: string | null, seg: number | null, dflt: number): number {
  if (fromDay === "" && rest > 0) return rest;
  if (fromDay) {
    const there = dayPieces(ss, fromDay);
    if (there.length) return seg !== null && there[seg] ? there[seg].dur : sessionsTotal(there) || estimate || dflt;
  }
  return estimate || dflt;
}


/** The properties that say where the rest of a task lives. */
export interface RestPlace { week: string | null; later: string | null; horizon: string | null; }
export const NO_REST: RestPlace = { week: null, later: null, horizon: null };
