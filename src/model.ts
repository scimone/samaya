import { App, Notice, TFile, normalizePath } from "obsidian";
import type { SamayaSettings } from "./settings";
import { Horizon, horizonTarget, isHorizon, minToHm, safeFileName, startOfWeek, today } from "./util";
import { DEFAULT_TASK_TEMPLATE, ensureSubtasksHeading, insertSubtask, renderPath, pathRoot, renderTemplate, TicketVars, DEFAULT_TICKET_TEMPLATE, renderTicketNote, renderTicketFileName, renderTicketPath } from "./taskbody";
import type { RawTicket } from "./tickets";
import { Seg } from "./segments";
import { Piece, RestPlace, Session, addMinutes, dayMinutes, dayPieces, formatSession, replaceDay, sessionDays, sessionsTotal, takePiece } from "./sessions";
import { applyTaskPatch, readPlanning, readProp, sessionsOf } from "./taskprops";

export interface Task {
  file: TFile; title: string; status: "todo" | "done";
  /** day the task was checked off (YYYY-MM-DD, "" = unknown or open) */ completed: string;
  planned: string; start: string; estimate: number; actual: number; order: number; channel: string;
  /** link path of the assigned ticket note ("" = none) */ ticket: string;
  /** week-start date (YYYY-MM-DD) for "this week" tasks without a day */ week: string;
  /** date a parked backlog task becomes due ("" = none); once reached it counts as this week's task */ later: string;
  /** backlog bucket the task is parked in ("" = none yet, shown as Someday) */ horizon: Horizon | "";
  /** time segments when the task is split around meetings (2+), else empty; `start` is the first one, `estimate` the total */ segments: Seg[];
  /** every planned piece, on every day (`planned` / `start` / `segments` describe the first day only) */ sessions: Session[];
  /** minutes of the estimate that are not planned yet; they wait in this week's list or in the backlog (0 = everything is planned) */ rest: number;
  /** Set on the view of one day (or of the rest) of a task that is spread over several days: `estimate`, `planned`, `start` and `segments` then describe that part only. */
  part?: Part;
}
/** What a task's per-day view knows about the whole task. */
export interface Part {
  kind: "day" | "rest";
  /** estimate of the whole task */ total: number;
  /** the task's other pieces, per day (the rest is not in here) */ others: Array<{ date: string; dur: number }>;
  /** minutes still unplanned */ rest: number;
  /** pieces before this day's, and all pieces: the "2/3" of a piece */ nth: number; count: number;
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => { const n = Number(v); return isNaN(n) ? 0 : n; };

/** Parsed tasks, remembered per frontmatter object: Obsidian hands out the same object until the note is parsed again, so an edit invalidates by itself. The day is part of the key (due / week depend on today). Treat a Task as read-only. */
const taskMemo = new WeakMap<object, { day: string; base: string; task: Task }>();
export function readTask(app: App, file: TFile): Task {
  const raw = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!raw) return parseTask(file, {});
  const day = today(); const hit = taskMemo.get(raw);
  if (hit && hit.day === day && hit.base === file.basename && hit.task.file === file) return hit.task;
  const task = parseTask(file, raw as Record<string, unknown>);
  taskMemo.set(raw, { day, base: file.basename, task });
  return task;
}
function parseTask(file: TFile, fm: Record<string, unknown>): Task {
  const planning = readPlanning(fm); const { planned, start, segments } = planning;
  const ymdOf = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v).slice(0, 10)) ? str(v).slice(0, 10) : "");
  const estimate = num(readProp(fm, "estimate")); const sessions = sessionsOf(planning, estimate);
  const later = ymdOf(fm.later); const parked = !!(later || ymdOf(fm.week) || isHorizon(str(fm.horizon)));
  const rest = sessions.length && parked ? Math.max(0, estimate - sessionsTotal(sessions)) : 0;
  const due = !!later && later <= today() && (!planned || rest > 0);
  return {
    file, title: file.basename, later, horizon: isHorizon(str(fm.horizon)) ? (str(fm.horizon) as Horizon) : "",
    status: fm.status === "done" ? "done" : "todo",
    completed: fm.status === "done" ? ymdOf(fm.day_completed) : "",
    planned, start,
    estimate, sessions, rest, actual: num(readProp(fm, "actual")), order: fm.order == null ? 1e6 : num(fm.order),
    channel: str(fm.channel),
    ticket: str(readProp(fm, "ticket")).replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim(),
    week: due ? startOfWeek(today()) : ymdOf(fm.week),
    segments,
  };
}

/** Unfinished and left behind: planned for an earlier day, or (with no day) assigned to an earlier week. */
export function isOverdue(t: Task): boolean {
  if (t.status === "done") return false;
  return t.planned ? t.planned < today() : !!t.week && t.week < startOfWeek(today());
}

export function allTasks(app: App, s: SamayaSettings): Task[] {
  const prefix = prefixOf(s.tasksPath);
  return app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(f => readTask(app, f));
}
export function sortTasks(ts: Task[]): Task[] {
  return ts.sort((a, b) => (a.start && b.start ? a.start.localeCompare(b.start) : 0) || a.order - b.order || a.title.localeCompare(b.title));
}


// ---------- tasks spread over several days ----------
/** More than one planned piece, or a part that is still unplanned: moving or resizing it works on one piece, not on the task as a whole. */
export const isMulti = (t: Task): boolean => t.sessions.length > 1 || t.rest > 0;
/** Pieces on more than one day, or a rest: such a task shows up once per day (and once for its rest). */
export const isSpread = (t: Task): boolean => t.rest > 0 || sessionDays(t.sessions).length > 1;

function partOf(t: Task, kind: Part["kind"], date: string): Part {
  const others = sessionDays(t.sessions).filter(d => d !== date).map(d => ({ date: d, dur: dayMinutes(t.sessions, d) }));
  const nth = kind === "rest" ? t.sessions.length : t.sessions.findIndex(g => g.date === date);
  return { kind, total: t.estimate, others, rest: t.rest, nth: Math.max(0, nth), count: t.sessions.length + (t.rest > 0 ? 1 : 0) };
}
/** One day of a task: `planned`, `start`, `segments` and `estimate` describe that day's pieces only. A task planned on one day only is returned as it is. */
export function dayTask(t: Task, date: string): Task {
  if (!isSpread(t)) return t;
  const mine = dayPieces(t.sessions, date); const timed = mine.filter(g => g.s !== null);
  return { ...t, planned: date, estimate: sessionsTotal(mine), start: timed.length ? minToHm(timed[0].s!) : "",
    segments: timed.length > 1 ? timed.map((g): Seg => ({ s: g.s!, dur: g.dur })) : [], part: partOf(t, "day", date) };
}
/** The part of a task that is not planned yet (waiting in this week's list or in the backlog). */
export function restTask(t: Task): Task {
  return { ...t, planned: "", start: "", segments: [], estimate: t.rest, part: partOf(t, "rest", "") };
}
/** What is planned for `date`: tasks with a piece on that day, each showing that day's piece. Tasks already checked off on an earlier day are left out (they neither show nor count towards capacity). */
export function onDay(all: Task[], date: string): Task[] {
  const out: Task[] = [];
  for (const t of all) if (t.sessions.some(g => g.date === date) && !(t.status === "done" && t.completed && t.completed < date)) out.push(dayTask(t, date));
  return out;
}
/** Tasks without a day: the ones never planned, and the unplanned rest of tasks that are planned in part. */
export function unplanned(all: Task[]): Task[] {
  const out: Task[] = [];
  for (const t of all) { if (t.rest > 0) out.push(restTask(t)); else if (!t.planned) out.push(t); }
  return out;
}
/** Work left behind: pieces of earlier days that are not done, and unplanned work of earlier weeks. One card per earlier day. */
export function overdueParts(all: Task[], day = today(), wk = startOfWeek(day)): Task[] {
  const out: Task[] = [];
  for (const t of all) {
    if (t.status === "done") continue;
    for (const d of sessionDays(t.sessions)) if (d < day) out.push(dayTask(t, d));
    if (!t.sessions.length ? !!t.week && t.week < wk : t.rest > 0 && !!t.week && t.week < wk) out.push(t.sessions.length ? restTask(t) : t);
  }
  return out;
}

/** Patch frontmatter as is; undefined/null/"" removes the key. For notes that are not tasks (projects, meetings, tickets). */
export async function patchNote(app: App, file: TFile, patch: Record<string, string | number | string[] | null | undefined>): Promise<void> {
  await app.fileManager.processFrontMatter(file, fm => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === "") delete fm[k]; else fm[k] = v;
    }
  });
}
/**
 * Patch a task note. Keys are the Task fields: planned (day), start, segments, estimate, actual, ticket, completed, samaya_project
 * are written as planned_sessions, duration_estimate, duration_actual, assigned_ticket, day_completed, assigned_project.
 * undefined/null/"" removes the property.
 */
export async function patchTask(app: App, file: TFile, patch: Record<string, string | number | string[] | null | undefined>): Promise<void> {
  await app.fileManager.processFrontMatter(file, fm => {
    // giving a task a day or a week ends its parking
    if (!("later" in patch) && (patch.planned || patch.week || (Array.isArray(patch.sessions) && patch.sessions.length))) { delete fm.later; delete fm.horizon; }
    applyTaskPatch(fm, patch);
  });
}
/** Park a task in the backlog under Next week / month / quarter / year / Someday / Never. It moves to this week by itself when the date arrives. */
export async function parkTask(app: App, file: TFile, h: Horizon): Promise<void> {
  await patchTask(app, file, { planned: null, start: null, week: null, later: horizonTarget(h, today()) || null, horizon: h });
}
/** Persist the move of parked tasks whose date has arrived into this week, and file unparked backlog tasks under Someday. Returns how many tasks changed. */
export async function promoteParked(app: App, s: SamayaSettings): Promise<number> {
  const t0 = today(); const due = allTasks(app, s).filter(t => t.later && t.later <= t0 && (!t.planned || t.rest > 0) && t.status !== "done");
  await Promise.all(due.map(t => patchTask(app, t.file, { week: startOfWeek(t0), later: null })));
  return due.length;
}

export async function setDone(app: App, t: Task, done: boolean): Promise<void> {
  await patchTask(app, t.file, { status: done ? "done" : "todo", completed: done ? today() : null });
}

export async function ensureFolder(app: App, path: string): Promise<void> {
  let cur = "";
  for (const seg of normalizePath(path).split("/")) {
    cur = cur ? `${cur}/${seg}` : seg;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur).catch(() => undefined);
  }
}
/** Read a user template by path ("" -> fallback). */
export async function loadTemplate(app: App, path: string, fallback: string): Promise<string> {
  if (!path.trim()) return fallback;
  let p = normalizePath(path.trim()); if (!p.endsWith(".md")) p += ".md";
  const f = app.vault.getAbstractFileByPath(p);
  if (f instanceof TFile) return app.vault.cachedRead(f);
  new Notice(`Samaya: template "${path}" not found, using the default.`);
  return fallback;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const momentFmt = (d: Date, f: string): string => (window as any).moment(d).format(f);
/** Folder for a path-pattern setting on a given date, e.g. "[Tasks]/YYYY/MM" -> "Tasks/2026/11". */
export const folderFor = (pattern: string, d: Date): string => normalizePath(renderPath(pattern, d, momentFmt) || "/");
/** Date-independent root of a path-pattern setting; every note managed by the pattern lives below it. */
export const rootOf = (pattern: string): string => normalizePath(pathRoot(pattern, momentFmt) || "/");
/** Vault-path prefix (with trailing slash) matching everything under the pattern's root; "" for the vault root. */
/** Path prefix of the notes under a path pattern. A pattern that resolves to the vault root matches nothing (never "every note in the vault is a task / ticket"). */
export const prefixOf = (pattern: string): string => { const r = rootOf(pattern); return r === "/" ? "\u0000/" : r + "/"; };

/** New task note in the tasks path, body from the task template (with "## Subtasks" guaranteed). */
export async function createTask(app: App, s: SamayaSettings, title: string, fm: Record<string, string | number>, body?: string): Promise<TFile> {
  const now = new Date(); const folder = folderFor(s.tasksPath, now);
  await ensureFolder(app, folder);
  const base = safeFileName(title); let path = `${folder}/${base}.md`; let i = 2;
  while (app.vault.getAbstractFileByPath(path)) path = `${folder}/${base} ${i++}.md`;
  const tpl = body ?? renderTemplate(await loadTemplate(app, s.taskTemplate, DEFAULT_TASK_TEMPLATE), { title, date: now }, momentFmt);
  const props: Record<string, string | number> = { status: "todo", ...fm };
  const body2 = ensureSubtasksHeading(tpl);
  // Write the properties together with the note. Creating it bare and patching afterwards lets the "file by planned date"
  // handler move it to Unscheduled in between, and the properties (day, estimate) could get lost.
  if (!body2.trimStart().startsWith("---")) {
    const out: Record<string, unknown> = {}; applyTaskPatch(out, props);
    const scalar = (v: unknown) => (typeof v === "number" || /^[\w.:-]+$/.test(String(v)) ? String(v) : JSON.stringify(v));
    const yaml = Object.entries(out).map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map(x => `  - ${/^[\w.: -]+$/.test(String(x)) ? x : JSON.stringify(x)}`).join("\n")}` : `${k}: ${scalar(v)}`).join("\n");
    return app.vault.create(path, `---\n${yaml}\n---\n${body2}`);
  }
  const file = await app.vault.create(path, body2);
  await patchTask(app, file, props);
  return file;
}


// ---------- subtasks (checkbox lines inside the task note) ----------
export interface Subtask { text: string; done: boolean; line: number; indent: number; }

export async function readSubtasks(app: App, file: TFile): Promise<Subtask[]> {
  const items = app.metadataCache.getFileCache(file)?.listItems?.filter(l => l.task !== undefined) ?? [];
  if (!items.length) return [];
  const lines = (await app.vault.cachedRead(file)).split("\n");
  return items.map(l => {
    const line = l.position.start.line; const raw = lines[line] ?? "";
    const m = raw.match(/^(\s*)[-*+]\s+\[.\]\s+(.*)$/);
    return { text: m ? m[2] : raw.trim(), done: l.task !== " ", line, indent: m ? m[1].replace(/\t/g, "  ").length : 0 };
  });
}
export async function toggleSubtask(app: App, file: TFile, line: number, done: boolean): Promise<void> {
  await app.vault.process(file, txt => {
    const ls = txt.split("\n"); if (ls[line] !== undefined) ls[line] = ls[line].replace(/\[.\]/, done ? "[x]" : "[ ]"); return ls.join("\n");
  });
}
export async function addSubtask(app: App, file: TFile, text: string): Promise<void> {
  await app.vault.process(file, txt => insertSubtask(txt, text));
}

// ---------- tickets (Jira / GitLab / manual), stored as notes ----------
export interface Ticket { file: TFile; id: string; key: string; source: string; summary: string; url: string; state: string; issueType: string; assignee: string; project: string; }

const ticketMemo = new WeakMap<object, { base: string; ticket: Ticket }>(); // per frontmatter object, like taskMemo
export function readTicket(app: App, file: TFile): Ticket {
  const raw = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!raw) return parseTicket(file, {});
  const hit = ticketMemo.get(raw); if (hit && hit.base === file.basename && hit.ticket.file === file) return hit.ticket;
  const ticket = parseTicket(file, raw as Record<string, unknown>); ticketMemo.set(raw, { base: file.basename, ticket });
  return ticket;
}
function parseTicket(file: TFile, fm: Record<string, unknown>): Ticket {
  // Notes written by versions <= 0.1.3 used key / summary / state / issue_type (and type: ticket); still understood.
  const type = str(fm.type);
  return { file, id: str(fm.id) || file.basename, key: str(fm.key) || str(fm.id) || file.basename, source: str(fm.source) || "manual",
    summary: str(fm.title) || str(fm.summary), url: str(fm.url), state: str(fm.status) || str(fm.state),
    issueType: str(fm.issue_type) || (type === "ticket" ? "" : type), assignee: str(fm.assignee), project: str(fm.project) };
}
export function allTickets(app: App, s: SamayaSettings): Ticket[] {
  const prefix = prefixOf(s.ticketsPath);
  return app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(f => readTicket(app, f))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}
export function ticketPathOf(app: App, t: Task): string {
  if (!t.ticket) return "";
  return app.metadataCache.getFirstLinkpathDest(t.ticket, t.file.path)?.path ?? "";
}
export async function assignTicket(app: App, task: TFile, ticket: Ticket | null): Promise<void> {
  await patchTask(app, task, { ticket: ticket ? `[[${ticket.file.basename}]]` : null });
}

export const SOURCE_NAMES: Record<string, string> = { jira: "Jira", gitlab: "GitLab", manual: "Manual" };
export const varsOfRaw = (t: RawTicket): TicketVars => ({ id: t.key, title: t.summary, type: t.type, status: t.state, assignedTo: t.assignee, url: t.url, description: t.description, source: SOURCE_NAMES[t.source] ?? t.source, project: t.project });
export const varsOfTicket = (t: Ticket): TicketVars => ({ id: t.key, title: t.summary, type: t.issueType, status: t.state, assignedTo: t.assignee, url: t.url, description: "", source: SOURCE_NAMES[t.source] ?? t.source, project: t.project });
/** Folder for a ticket note: the tickets path with {{TICKET_*}} variables and date parts filled in. */
export const ticketFolderFor = (s: SamayaSettings, v: TicketVars, d: Date): string => normalizePath(renderTicketPath(s.ticketsPath, v, d, momentFmt) || "/");

/** Frontmatter of a ticket note. `url` is what sync matches on. */
export const ticketProps = (source: string, v: TicketVars) =>
  ({ source, id: v.id, title: v.title, project: v.project, status: v.status, type: v.type, assignee: v.assignedTo, url: v.url, aliases: v.id ? [v.id] : null });
/** Properties from older versions, removed when a ticket is updated. */
export const LEGACY_TICKET_PROPS = { key: null, summary: null, state: null, issue_type: null };

/** New ticket note (path, file name and body from the ticket settings). Frontmatter is the caller's job. */
export async function createTicketNote(app: App, s: SamayaSettings, v: TicketVars, body?: string): Promise<TFile> {
  const now = new Date(); const folder = ticketFolderFor(s, v, now);
  await ensureFolder(app, folder);
  const base = renderTicketFileName(s.ticketFileName, v); let path = `${folder}/${base}.md`; let i = 2;
  while (app.vault.getAbstractFileByPath(path)) path = `${folder}/${base} ${i++}.md`;
  const tpl = body ?? renderTemplate(renderTicketNote(await loadTemplate(app, s.ticketTemplate, DEFAULT_TICKET_TEMPLATE), v), { title: v.title, date: now }, momentFmt);
  return app.vault.create(path, tpl);
}
/** Move a ticket note into the folder its variables now call for (e.g. after its status changed). */
export async function relocateTicket(app: App, s: SamayaSettings, t: Ticket, v: TicketVars): Promise<void> {
  const folder = ticketFolderFor(s, v, new Date()); const path = `${folder}/${t.file.name}`;
  if (path === t.file.path || app.vault.getAbstractFileByPath(path)) return;
  await ensureFolder(app, folder); await app.fileManager.renameFile(t.file, path);
}

/** Give the tasks of a day their order (only writes what changed); `path` goes to `index`, with `extra` written to it. */
async function renumberDay(app: App, s: SamayaSettings, path: string, date: string, index: number, extra: Record<string, string | number | null>): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
  const moved = readTask(app, f);
  const cur = sortTasks(onDay(allTasks(app, s), date).filter(t => t.file.path !== path));
  cur.splice(Math.max(0, Math.min(index, cur.length)), 0, moved);
  await Promise.all(cur.map((t, i) => {
    if (t.file.path === path) return patchTask(app, t.file, { ...extra, order: i });
    return t.order !== i ? patchTask(app, t.file, { order: i }) : Promise.resolve();
  }));
}
/** Put a task at `index` of the day's ordered list and renumber (only writes what changed). */
export async function placeInDay(app: App, s: SamayaSettings, path: string, date: string, index: number): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
  const moved = readTask(app, f);
  await renumberDay(app, s, path, date, index, { planned: date, week: null, estimate: moved.estimate || s.defaultEstimate, ...(moved.planned !== date ? { start: null } : {}) }); // moved from another day: its time slot no longer fits
}

// ---------- pieces: a task planned in several parts, on several days ----------
/** Where the unplanned rest of a task lives now. */
export function restPlaceOf(t: Task): RestPlace {
  const later = t.later && t.later > today() ? t.later : null;
  return { week: t.week || null, later, horizon: later ? t.horizon || null : null };
}
/** Write a task's pieces. The estimate becomes pieces + rest; the rest (if any) stays where `place` says. */
export async function writeSessions(app: App, file: TFile, sessions: Session[], rest: number, place: RestPlace): Promise<void> {
  const left = Math.max(0, Math.round(rest)); const total = sessionsTotal(sessions) + left;
  await patchTask(app, file, { sessions: sessions.map(formatSession), estimate: total || null, ...(left > 0 ? place : { week: null, later: null, horizon: null }) });
}
/** Replace what a task has on `date` by `pieces`; its other days and its rest stay. */
export async function writeDayPlan(app: App, file: TFile, date: string, pieces: Piece[]): Promise<void> {
  const t = readTask(app, file);
  await writeSessions(app, file, replaceDay(t.sessions, date, pieces), t.rest, restPlaceOf(t));
}
/** Take the time slot off a day of a task (the minutes stay on the day, in its list). */
export async function unscheduleDay(app: App, file: TFile, date: string): Promise<void> {
  const t = readTask(app, file);
  if (!isMulti(t)) { await patchTask(app, file, { start: null }); return; }
  const mins = dayMinutes(t.sessions, date); if (!mins) return;
  await writeSessions(app, file, replaceDay(t.sessions, date, [{ s: null, dur: mins }]), t.rest, restPlaceOf(t));
}
/** Where a piece of work can go: a day (at `index` of its list), "this week" without a day, or a backlog bucket. */
export type Dest = { day: string; index?: number } | { week: string } | { backlog: Horizon };
/** What is moved: a day's pieces (`day`; "" = the unplanned rest; null = not known), one of them (`seg`) or all of them. */
export interface Source { day: string | null; seg: number | null; }

/**
 * Send a task, or one piece of it, somewhere else. A task planned in one piece moves as a whole; a task in several pieces (or with a rest)
 * only moves the piece it was grabbed by: the other pieces stay where they are. Minutes sent to a day that already has a piece of the task
 * join it; minutes sent to the week or the backlog become the task's rest.
 */
export async function sendPiece(app: App, s: SamayaSettings, file: TFile, from: Source, dest: Dest): Promise<void> {
  const t = readTask(app, file);
  if (!isMulti(t)) {
    if ("day" in dest) await placeInDay(app, s, file.path, dest.day, dest.index ?? 9999);
    else if ("week" in dest) await patchTask(app, file, { planned: null, start: null, week: dest.week });
    else await parkTask(app, file, dest.backlog);
    return;
  }
  let ss = t.sessions; let rest = t.rest; let place = restPlaceOf(t);
  const day = from.day === "" ? "" : from.day && dayPieces(ss, from.day).length ? from.day : t.planned;
  if ("day" in dest && day === dest.day) { await renumberDay(app, s, file.path, dest.day, dest.index ?? 9999, {}); return; } // already there: only the order changes
  let mins: number;
  if (!day) { mins = rest; rest = 0; } else { const r = takePiece(ss, day, from.seg); ss = r.left; mins = r.mins; }
  if (mins <= 0) return;
  if ("day" in dest) ss = addMinutes(ss, dest.day, mins);
  else {
    rest += mins;
    place = "week" in dest ? { week: dest.week, later: null, horizon: null } : { week: null, later: horizonTarget(dest.backlog, today()) || null, horizon: dest.backlog };
  }
  await writeSessions(app, file, ss, rest, place);
  if ("day" in dest && dest.index !== undefined) await renumberDay(app, s, file.path, dest.day, dest.index, {});
}
/** New length of what is shown on a card: one day's minutes (a task in several parts) or the rest, else the task's estimate. */
export async function setPartEstimate(app: App, t: Task, minutes: number | null): Promise<void> {
  if (!t.part) { await patchTask(app, t.file, { estimate: minutes }); return; }
  const full = readTask(app, t.file); const m = Math.max(0, minutes ?? 0);
  if (t.part.kind === "rest") { await writeSessions(app, t.file, full.sessions, m, restPlaceOf(full)); return; }
  const timed = dayPieces(full.sessions, t.planned).filter(g => g.s !== null);
  const piece: Piece = timed.length ? { s: timed[0].s, dur: m } : { s: null, dur: m }; // a timed day keeps its first slot and gets the new length
  await writeSessions(app, t.file, replaceDay(full.sessions, t.planned, [piece]), full.rest, restPlaceOf(full));
}
/** Something was dropped on a day's list at `index`: a card or a timeline block (which loses its time slot). Works for whole tasks and for pieces. */
export async function dropOnDay(app: App, s: SamayaSettings, file: TFile, from: Source & { fromTimeline?: boolean }, date: string, index: number): Promise<void> {
  if (from.fromTimeline && (from.day === date || from.day === null)) await unscheduleDay(app, file, date);
  await sendPiece(app, s, file, from, { day: date, index });
}
