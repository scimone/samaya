// Pure logic for the task frontmatter format (no Obsidian imports, unit-tested).
//
//   planned_sessions:
//     - 2026-11-11 13:00-14:00     a timed session
//     - 2026-11-11                 a day without a time
//
// Internally a task still has `planned` (day), `start` and `segments` (when split); this module converts between the two.
import { Seg, fmtSegments, parseSegments, segsTotal } from "./segments";
import { hmToMin } from "./util";

/** Internal patch key -> frontmatter property. Everything else is written under its own name. */
export const PROP_RENAMES: Record<string, string> = {
  estimate: "duration_estimate", actual: "duration_actual", samaya_project: "assigned_project", ticket: "assigned_ticket", completed: "day_completed",
};
export const SESSIONS_PROP = "planned_sessions";
/** Properties written by earlier versions: still read, removed the next time the note is written. */
const LEGACY_PLANNING = ["planned", "start", "segments"];

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SESSION = /^\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2}))?\s*$/;

export interface Planning { planned: string; start: string; segments: Seg[]; }

/** `planned_sessions` list -> the day (of the first session), the first start and, with 2+ timed sessions that day, the segments. */
export function parseSessions(raw: unknown): Planning {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  let planned = ""; const segs: Seg[] = [];
  for (const x of list) {
    const m = String(x).match(SESSION); if (!m) continue;
    if (!planned) planned = m[1];
    if (m[1] !== planned || !m[2]) continue;
    const s = hmToMin(m[2]), e = hmToMin(m[3]); if (e > s) segs.push({ s, dur: e - s });
  }
  segs.sort((a, b) => a.s - b.s);
  return { planned, start: segs.length ? fmtSegments([segs[0]])[0].slice(0, 5) : "", segments: segs.length > 1 ? segs : [] };
}

/** The `planned_sessions` list for a day, a start + length, or split segments. Empty without a day. */
export function buildSessions(p: Planning, estimate: number): string[] {
  if (!p.planned) return [];
  if (p.segments.length > 1) return fmtSegments(p.segments).map(r => `${p.planned} ${r}`);
  if (p.start) {
    const s = hmToMin(p.start); const [r] = fmtSegments([{ s, dur: Math.max(estimate, 1) }]);
    return [`${p.planned} ${r}`];
  }
  return [p.planned];
}

/** Planning of a note's frontmatter: the new `planned_sessions`, or the old planned / start / segments. */
export function readPlanning(fm: Record<string, unknown>): Planning {
  if (fm[SESSIONS_PROP] != null) return parseSessions(fm[SESSIONS_PROP]);
  const d = fm.planned; const day = d instanceof Date ? "" : String(d ?? "").slice(0, 10);
  const g = parseSegments(fm.segments);
  return { planned: YMD.test(day) ? day : "", start: /^\d{1,2}:\d{2}$/.test(String(fm.start ?? "")) ? String(fm.start) : "", segments: g.length > 1 ? g : [] };
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
  const next: Planning = { ...cur }; let estimate = curEstimate;
  // moved to another day: its time slot belonged to the old day, so it goes (unless a new slot is written with the move)
  const moved = typeof patch.planned === "string" && patch.planned !== "" && cur.planned !== patch.planned;
  if (moved && !has("start")) { next.start = ""; if (!has("segments")) next.segments = []; }
  if (has("planned")) next.planned = patch.planned ? String(patch.planned) : "";
  if (has("start")) next.start = patch.start ? String(patch.start) : "";
  if (has("estimate")) estimate = duration(patch.estimate);
  if (has("segments")) { const g = Array.isArray(patch.segments) ? parseSegments(patch.segments) : []; next.segments = g.length > 1 ? g : []; }
  // a split task keeps its segments only when they are written together with the new time or length
  else if (has("start") || (has("estimate") && curEstimate !== estimate)) next.segments = [];
  if (next.segments.length > 1) { next.start = fmtSegments([next.segments[0]])[0].slice(0, 5); if (!has("estimate")) estimate = segsTotal(next.segments); }

  // migrate old names, then write the patch
  for (const [internal, name] of Object.entries(PROP_RENAMES)) if (internal in fm) { if (fm[name] === undefined) fm[name] = fm[internal]; delete fm[internal]; }
  for (const [k, v] of Object.entries(patch)) {
    if (k === "planned" || k === "start" || k === "segments") continue;
    const name = PROP_RENAMES[k] ?? k;
    if (v === undefined || v === null || v === "") delete fm[name]; else fm[name] = v;
  }
  for (const k of LEGACY_PLANNING) delete fm[k];
  const sessions = buildSessions(next, estimate);
  if (sessions.length) fm[SESSIONS_PROP] = sessions; else delete fm[SESSIONS_PROP];
}
