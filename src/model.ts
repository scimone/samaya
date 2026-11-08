import { App, Notice, TFile, normalizePath, requestUrl } from "obsidian";
import { IcsEvent, parseIcs } from "./ics";
import type { SamayaSettings } from "./settings";
import { safeFileName } from "./util";
import { DEFAULT_TASK_TEMPLATE, ensureSubtasksHeading, insertSubtask, renderPath, pathRoot, renderTemplate, TicketVars, DEFAULT_TICKET_TEMPLATE, renderTicketNote, renderTicketFileName, renderTicketPath } from "./taskbody";
import type { RawTicket } from "./tickets";

export interface Task {
  file: TFile; title: string; status: "todo" | "done";
  planned: string; start: string; estimate: number; actual: number; order: number; channel: string;
  /** link path of the assigned ticket note ("" = none) */ ticket: string;
  /** week-start date (YYYY-MM-DD) for "this week" tasks without a day */ week: string;
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => { const n = Number(v); return isNaN(n) ? 0 : n; };

export function readTask(app: App, file: TFile): Task {
  const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
  const planned = fm.planned instanceof Date ? "" : str(fm.planned).slice(0, 10);
  return {
    file, title: file.basename,
    status: fm.status === "done" ? "done" : "todo",
    planned: /^\d{4}-\d{2}-\d{2}$/.test(planned) ? planned : "",
    start: /^\d{1,2}:\d{2}$/.test(str(fm.start)) ? str(fm.start) : "",
    estimate: num(fm.estimate), actual: num(fm.actual), order: fm.order == null ? 1e6 : num(fm.order),
    channel: str(fm.channel),
    ticket: str(fm.ticket).replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim(),
    week: /^\d{4}-\d{2}-\d{2}$/.test(str(fm.week).slice(0, 10)) ? str(fm.week).slice(0, 10) : "",
  };
}

export function allTasks(app: App, s: SamayaSettings): Task[] {
  const prefix = prefixOf(s.tasksPath);
  return app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(f => readTask(app, f));
}
export function sortTasks(ts: Task[]): Task[] {
  return ts.sort((a, b) => (a.start && b.start ? a.start.localeCompare(b.start) : 0) || a.order - b.order || a.title.localeCompare(b.title));
}

/** Patch frontmatter; undefined/null/"" removes the key. */
export async function patchTask(app: App, file: TFile, patch: Record<string, string | number | null | undefined>): Promise<void> {
  await app.fileManager.processFrontMatter(file, fm => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === "") delete fm[k]; else fm[k] = v;
    }
  });
}
export async function setDone(app: App, t: Task, done: boolean): Promise<void> {
  await patchTask(app, t.file, { status: done ? "done" : "todo", completed: done ? new Date().toISOString().slice(0, 10) : null });
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
export const prefixOf = (pattern: string): string => { const r = rootOf(pattern); return r === "/" ? "" : r + "/"; };

/** New task note in the tasks path, body from the task template (with "## Subtasks" guaranteed). */
export async function createTask(app: App, s: SamayaSettings, title: string, fm: Record<string, string | number>, body?: string): Promise<TFile> {
  const now = new Date(); const folder = folderFor(s.tasksPath, now);
  await ensureFolder(app, folder);
  const base = safeFileName(title); let path = `${folder}/${base}.md`; let i = 2;
  while (app.vault.getAbstractFileByPath(path)) path = `${folder}/${base} ${i++}.md`;
  const tpl = body ?? renderTemplate(await loadTemplate(app, s.taskTemplate, DEFAULT_TASK_TEMPLATE), { title, date: now }, momentFmt);
  const file = await app.vault.create(path, ensureSubtasksHeading(tpl));
  await patchTask(app, file, { status: "todo", ...fm });
  return file;
}

export async function subtaskProgress(app: App, file: TFile): Promise<{ done: number; total: number }> {
  const cache = app.metadataCache.getFileCache(file);
  const items = cache?.listItems?.filter(l => l.task !== undefined) ?? [];
  return { done: items.filter(l => l.task !== " ").length, total: items.length };
}

export class IcsClient {
  private cache = new Map<string, { at: number; text: string }>();
  constructor(private getSettings: () => SamayaSettings) {}
  clear() { this.cache.clear(); }
  async eventsBetween(from: Date, to: Date): Promise<IcsEvent[]> {
    const s = this.getSettings(); const out: IcsEvent[] = [];
    for (const url of s.icsUrls) {
      try {
        let hit = this.cache.get(url);
        if (!hit || Date.now() - hit.at > s.icsRefreshMinutes * 60000) {
          const res = await requestUrl({ url });
          hit = { at: Date.now(), text: res.text }; this.cache.set(url, hit);
        }
        out.push(...parseIcs(hit.text, from, to));
      } catch (e) { console.warn("Samaya: failed to load ICS", url, e); }
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime());
  }
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
export interface Ticket { file: TFile; id: string; key: string; source: string; summary: string; url: string; state: string; issueType: string; assignee: string; }

export function readTicket(app: App, file: TFile): Ticket {
  const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
  return { file, id: str(fm.id) || file.basename, key: str(fm.key) || file.basename, source: str(fm.source) || "manual",
    summary: str(fm.summary), url: str(fm.url), state: str(fm.state), issueType: str(fm.issue_type), assignee: str(fm.assignee) };
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

const SOURCE_NAMES: Record<string, string> = { jira: "Jira", gitlab: "GitLab", manual: "Manual" };
export const varsOfRaw = (t: RawTicket): TicketVars => ({ id: t.key, title: t.summary, type: t.type, status: t.state, assignedTo: t.assignee, url: t.url, description: t.description, source: SOURCE_NAMES[t.source] ?? t.source });
export const varsOfTicket = (t: Ticket): TicketVars => ({ id: t.key, title: t.summary, type: t.issueType, status: t.state, assignedTo: t.assignee, url: t.url, description: "", source: SOURCE_NAMES[t.source] ?? t.source });
/** Folder for a ticket note: the tickets path with {{TASK_*}} variables and date parts filled in. */
export const ticketFolderFor = (s: SamayaSettings, v: TicketVars, d: Date): string => normalizePath(renderTicketPath(s.ticketsPath, v, d, momentFmt) || "/");

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
export async function createManualTicket(app: App, s: SamayaSettings, key: string, summary: string): Promise<TFile> {
  const v: TicketVars = { id: key, title: summary, type: "", status: "open", assignedTo: "", url: "", description: "", source: "Manual" };
  const f = await createTicketNote(app, s, v, summary ? `# ${summary}\n` : "");
  await patchTask(app, f, { type: "ticket", source: "manual", id: key, key, summary, state: "open" });
  return f;
}

/** Put a task at `index` of the day's ordered list and renumber (only writes what changed). */
export async function placeInDay(app: App, s: SamayaSettings, path: string, date: string, index: number): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
  const moved = readTask(app, f);
  const cur = sortTasks(allTasks(app, s).filter(t => t.planned === date && t.file.path !== path));
  cur.splice(Math.max(0, Math.min(index, cur.length)), 0, moved);
  await Promise.all(cur.map((t, i) => {
    if (t.file.path === path) return patchTask(app, t.file, { planned: date, week: null, order: i, estimate: moved.estimate || s.defaultEstimate });
    return t.order !== i ? patchTask(app, t.file, { order: i }) : Promise.resolve();
  }));
}
