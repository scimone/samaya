// Pure logic for the task frontmatter format (no Obsidian imports, unit-tested).
//
//   planned_sessions:
//     - 2026-11-11 13:00-14:00     a timed session
//     - 2026-11-12 90m             a piece without a time (a task can have pieces on several days)
//     - 2026-11-11                 a day without a time (the whole estimate)
//
// Internally a task still has `planned` (day), `start` and `segments` (when split); this module converts between the two.
import { Seg, fmtSegments, parseSegments, segsTotal } from "./segments";
import { Session, formatSession, parseSessionList, resolveSessions, sessionsTotal, sortSessions } from "./sessions";
import { hmToMin } from "./util";

/** Internal patch key -> frontmatter property. Everything else is written under its own name. */
export const PROP_RENAMES: Record<string, string> = {
  estimate: "duration_estimate", actual: "duration_actual", samaya_project: "assigned_project", ticket: "assigned_ticket", completed: "day_completed",
};
export const SESSIONS_PROP = "planned_sessions";
/** Properties written by earlier versions: still read, removed the next time the note is written. */
const LEGACY_PLANNING = ["planned", "start", "segments"];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface Planning { planned: string; start: string; segments: Seg[]; /** every session on every day (a day without a length has dur 0 until resolved) */ sessions: Session[]; }

/** `planned_sessions` list -> the first day, its first start and, with 2+ timed sessions that day, the segments; plus all sessions of all days. */
export function parseSessions(raw: unknown): Planning {
  const sessions = parseSessionList(raw);
  const planned = sessions[0]?.date ?? "";
  const timed = sessions.filter(g => g.date === planned && g.s !== null).map((g): Seg => ({ s: g.s!, dur: g.dur }));
  return { planned, start: timed.length ? fmtSegments([timed[0]])[0].slice(0, 5) : "", segments: timed.length > 1 ? timed : [], sessions };
}

/** The sessions of a planning: the listed ones, or (older notes) the day / start / segments with the estimate as length. */
export function sessionsOf(p: Planning, estimate: number): Session[] {
  if (p.sessions.length) return resolveSessions(p.sessions, estimate);
  return buildPrimary(p, estimate, false);
}
/** The sessions of the planning's day: split segments, one timed session of `estimate` minutes, or the day alone. */
function buildPrimary(p: Planning, estimate: number, explicit: boolean): Session[] {
  if (!p.planned) return [];
  if (p.segments.length > 1) return p.segments.map(g => ({ date: p.planned, s: g.s, dur: g.dur }));
  if (p.start) return [{ date: p.planned, s: hmToMin(p.start), dur: Math.max(estimate, 1) }];
  return [{ date: p.planned, s: null, dur: explicit ? Math.max(estimate, 0) : 0 }];
}

/** Planning of a note's frontmatter: the new `planned_sessions`, or the old planned / start / segments. */
export function readPlanning(fm: Record<string, unknown>): Planning {
  if (fm[SESSIONS_PROP] != null) return parseSessions(fm[SESSIONS_PROP]);
  const d = fm.planned; const day = d instanceof Date ? "" : String(d ?? "").slice(0, 10);
  const g = parseSegments(fm.segments);
  return { planned: YMD.test(day) ? day : "", start: /^\d{1,2}:\d{2}$/.test(String(fm.start ?? "")) ? String(fm.start) : "", segments: g.length > 1 ? g : [], sessions: [] };
}

/** Value of a property under its current name, falling back to the one older versions used. */
export function readProp(fm: Record<string, unknown>, internal: string): unknown {
  const cur = PROP_RENAMES[internal];
  return cur ? (fm[cur] ?? fm[internal]) : fm[internal];
}

const duration = (v: unknown): number => { const n = Number(v); return isNaN(n) ? 0 : n; };

/**
 * Apply a patch written in internal keys (planned, start, segments, estimate, ticket, ...) to a frontmatter object.
 * undefined / null / "" removes a key. Old property names are migrated on the way.
 */
export function applyTaskPatch(fm: Record<string, unknown>, patch: Record<string, unknown>): void {
  const has = (k: string) => k in patch;
  const cur = readPlanning(fm); const curEstimate = duration(readProp(fm, "estimate"));
  let estimate = curEstimate; let sessions: Session[] | null;
  if (has("estimate")) estimate = duration(patch.estimate);
  const planning = has("planned") || has("start") || has("segments");
  if (has("sessions")) {
    // the whole list at once (a task with pieces on several days): written as given, the legacy keys are ignored
    sessions = Array.isArray(patch.sessions) ? parseSessionList(patch.sessions) : [];
  } else if (!planning && (cur.sessions.length > 1 || (!has("estimate") && fm[SESSIONS_PROP] != null))) {
    sessions = null; // nothing about the day or time changes (a new estimate does not reshape pieces that are already planned): they are written back as they are
  } else {
    const curSessions = sessionsOf(cur, curEstimate);
    const next: Planning = { ...cur };
    // moved to another day: its time slot belonged to the old day, so it goes (unless a new slot is written with the move)
    const moved = typeof patch.planned === "string" && patch.planned !== "" && cur.planned !== patch.planned;
    if (moved && !has("start")) { next.start = ""; if (!has("segments")) next.segments = []; }
    if (has("planned")) next.planned = patch.planned ? String(patch.planned) : "";
    if (has("start")) next.start = patch.start ? String(patch.start) : "";
    if (has("segments")) { const g = Array.isArray(patch.segments) ? parseSegments(patch.segments) : []; next.segments = g.length > 1 ? g : []; }
    // a split task keeps its segments only when they are written together with the new time or length
    else if (has("start") || (has("estimate") && curEstimate !== estimate)) next.segments = [];
    if (next.segments.length > 1) { next.start = fmtSegments([next.segments[0]])[0].slice(0, 5); if (!has("estimate")) estimate = segsTotal(next.segments); }
    // pieces on other days stay, unless the task as a whole is moved to another day or taken off the calendar
    const cleared = has("planned") && !patch.planned;
    const keep = moved || cleared ? [] : curSessions.filter(g => g.date !== cur.planned);
    sessions = sortSessions([...buildPrimary(next, estimate - sessionsTotal(keep), keep.length > 0), ...keep]);
  }

  // migrate old names, then write the patch
  for (const [internal, name] of Object.entries(PROP_RENAMES)) if (internal in fm) { if (fm[name] === undefined) fm[name] = fm[internal]; delete fm[internal]; }
  for (const [k, v] of Object.entries(patch)) {
    if (k === "planned" || k === "start" || k === "segments" || k === "sessions") continue;
    const name = PROP_RENAMES[k] ?? k;
    if (v === undefined || v === null || v === "") delete fm[name]; else fm[name] = v;
  }
  for (const k of LEGACY_PLANNING) delete fm[k];
  if (sessions) { if (sessions.length) fm[SESSIONS_PROP] = sessions.map(formatSession); else delete fm[SESSIONS_PROP]; }
}
