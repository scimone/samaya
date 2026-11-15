// Keeps tasks, tickets and projects consistent (a project linked to a whole ticket project never hands out one of its tickets on its own): a task assigned to a ticket that belongs to a project is assigned to that project too, and the other way round.
import { App, Notice, TFile, normalizePath } from "obsidian";
import type { SamayaSettings } from "./settings";
import { Ticket, allTasks, allTickets, assignTicket, readTask, ticketPathOf } from "./model";
import { Project, allProjects, assignProject, linkTickets, projectPathOf, readProject } from "./projects";
import { patchNote } from "./model";
import { noteColor, randomColor, setTicketProjectColor as setColorOf, ticketProjectColor, writeNoteColor } from "./itemcolor";
import { buildSeries, parseNote } from "./meetingseries";

/** The Jira / GitLab project a project note is linked to as a whole ("" = none). */
const ticketProjectOf = (app: App, project: TFile): string => String(app.metadataCache.getFileCache(project)?.frontmatter?.ticket_project ?? "");
const fileAt = (app: App, path: string): TFile | null => { const f = path ? app.vault.getAbstractFileByPath(path) : null; return f instanceof TFile ? f : null; };

/** The project a ticket belongs to (path, "" = none): the one its note points at, else the one linked to the ticket's whole Jira / GitLab project. */
export function ownerProjectOf(app: App, s: SamayaSettings, ticket: Ticket): string {
  const direct = projectPathOf(app, ticket.file); if (direct) return direct;
  return ticket.project ? allProjects(app, s).find(p => String(app.metadataCache.getFileCache(p.file)?.frontmatter?.ticket_project ?? "") === ticket.project)?.file.path ?? "" : "";
}
/** The colour a ticket shows: the one of its ticket project ("" = default look). */
export function ticketColorOf(_app: App, s: SamayaSettings, ticket: Ticket): string { return ticketProjectColor(s, ticket.project); }
/** Set the colour of a ticket project (all its tickets change); a project made from it follows. */
export async function setTicketProjectColor(app: App, s: SamayaSettings, key: string, hex: string): Promise<void> {
  await setColorOf(s, key, hex);
  for (const p of allProjects(app, s)) if (key && ticketProjectOf(app, p.file) === key) await writeNoteColor(app, p.file, hex);
}
/** Set a project's colour; if it was made from a ticket project, that ticket project follows. */
export async function setProjectColor(app: App, s: SamayaSettings, project: TFile, hex: string): Promise<void> {
  await writeNoteColor(app, project, hex);
  const tp = ticketProjectOf(app, project); if (tp) await setColorOf(s, tp, hex);
}
/** Whether this task may be assigned to this ticket: not when the task is in one project and the ticket belongs to another. */
export function ticketFits(app: App, s: SamayaSettings, task: TFile, ticket: Ticket): boolean {
  const mine = projectPathOf(app, task), owner = ownerProjectOf(app, s, ticket);
  return !mine || !owner || mine === owner;
}
/** Whether this task may be assigned to this project: not when its ticket belongs to another project. */
export function projectFits(app: App, s: SamayaSettings, task: TFile, project: Project): boolean {
  const tp = ticketPathOf(app, readTask(app, task)); const tk = tp ? allTickets(app, s).find(t => t.file.path === tp) : undefined;
  const owner = tk ? ownerProjectOf(app, s, tk) : "";
  return !owner || owner === project.file.path;
}

/** Assign a task to a ticket (or clear it); the ticket's project, if it has one, becomes the task's project. */
export async function assignTicketLinked(app: App, s: SamayaSettings, task: TFile, ticket: Ticket | null): Promise<void> {
  if (ticket && !ticketFits(app, s, task, ticket)) { new Notice(`${ticket.key} belongs to another project than this task. Change the task's project first.`); return; }
  await assignTicket(app, task, ticket);
  const pf = ticket && s.projectsOn ? fileAt(app, projectPathOf(app, ticket.file)) : null;
  if (pf) await assignProject(app, task, readProject(app, pf));
}
/** Assign a task to a project (or clear it); if the project is linked to exactly one single ticket (not to a whole ticket project) and the task has none, that ticket becomes the task's ticket. */
export async function assignProjectLinked(app: App, s: SamayaSettings, task: TFile, project: Project | null): Promise<void> {
  if (project && !projectFits(app, s, task, project)) { new Notice(`This task's ticket belongs to another project. Change or remove the ticket first.`); return; }
  await assignProject(app, task, project);
  if (!project || ticketProjectOf(app, project.file)) return; // a ticket project: the task stays on the project, no ticket is picked for it
  const tickets = allTickets(app, s).filter(t => projectPathOf(app, t.file) === project.file.path);
  const hasTicket = allTasks(app, s).find(t => t.file.path === task.path)?.ticket;
  if (tickets.length === 1 && !hasTicket) await assignTicket(app, task, tickets[0]);
}

/** Link tickets to a project, then bring the tasks in line: tasks of those tickets join the project, and tasks of the project join its only ticket. */
export async function linkProject(app: App, s: SamayaSettings, project: TFile, tickets: Ticket[], ticketProject?: string): Promise<void> {
  await linkTickets(app, project, tickets.map(t => t.file), ticketProject);
  // connected = same colour: a whole ticket project takes the project's colour; single tickets can't recolour their ticket project, so the project takes theirs
  const tp = ticketProject || tickets.find(t => t.project)?.project || "";
  let pc = noteColor(app, project);
  if (ticketProject) { if (!pc) { pc = randomColor(); await writeNoteColor(app, project, pc); } await setColorOf(s, ticketProject, pc); }
  else if (tp && ticketProjectColor(s, tp) && ticketProjectColor(s, tp) !== pc) await writeNoteColor(app, project, ticketProjectColor(s, tp));
  const linked = new Map(allTickets(app, s).filter(t => projectPathOf(app, t.file) === project.path).map(t => [t.file.path, t] as const));
  for (const t of tickets) linked.set(t.file.path, t); // the cache may not have caught up with the notes just written
  const only = linked.size === 1 && !ticketProject && !ticketProjectOf(app, project) ? [...linked.values()][0] : null;
  const pr = readProject(app, project);
  for (const t of allTasks(app, s)) {
    if (t.ticket && linked.has(ticketPathOf(app, t))) { if (projectPathOf(app, t.file) !== project.path) await assignProject(app, t.file, pr); }
    else if (!t.ticket && only && projectPathOf(app, t.file) === project.path) await assignTicket(app, t.file, only);
  }
}

// ---- meetings: a meeting note points at any number of projects and tickets: `assigned_project` / `assigned_ticket` hold one link, or a list of links when there are several
/** Path prefix of the meeting notes. */
export const meetingsPrefix = (s: SamayaSettings): string => normalizePath(s.eventNotesFolder.trim() || "Meetings") + "/";
export type MeetingProp = "assigned_project" | "assigned_ticket";
/** The links a property holds, as written (one string, a list, or the nested list Obsidian makes of an unquoted [[link]]). */
function rawLinks(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(rawLinks);
  const link = String(v ?? "").replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
  return link ? [link] : [];
}
/** Paths of the notes a meeting points at via `prop` (links that do not resolve are skipped). */
export function meetingLinks(app: App, file: TFile, prop: MeetingProp): string[] {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  return [...new Set(rawLinks(fm?.[prop]).map(l => app.metadataCache.getFirstLinkpathDest(l, file.path)?.path ?? "").filter(Boolean))];
}
async function writeLinks(app: App, file: TFile, prop: MeetingProp, paths: string[]): Promise<void> {
  const names = paths.map(p => `[[${p.split("/").pop()!.replace(/\.md$/, "")}]]`);
  await patchNote(app, file, { [prop]: names.length === 0 ? null : names.length === 1 ? names[0] : names });
}
/** Add (or, with `remove`, drop) one project / ticket note on a meeting. */
export async function changeMeetingLink(app: App, s: SamayaSettings, note: TFile, prop: MeetingProp, target: string, remove = false): Promise<void> {
  const cur = meetingLinks(app, note, prop);
  if (remove) { if (cur.includes(target)) await writeLinks(app, note, prop, cur.filter(p => p !== target)); return; }
  if (!cur.includes(target)) await writeLinks(app, note, prop, [...cur, target]);
  if (prop === "assigned_ticket" && s.projectsOn) { // a ticket brings its project along
    const t = allTickets(app, s).find(x => x.file.path === target); const owner = t ? ownerProjectOf(app, s, t) : "";
    const projects = meetingLinks(app, note, "assigned_project");
    if (owner && !projects.includes(owner)) await writeLinks(app, note, "assigned_project", [...projects, owner]);
  }
}

/**
 * New instances of a recurring meeting (created by other code) take the assignment of their series: every instance with neither a project nor a ticket gets
 * the projects / tickets of the series' latest assigned instance. Instances that have any assignment are left alone. Returns how many notes were changed.
 */
export async function syncMeetingLinks(app: App, s: SamayaSettings): Promise<number> {
  if (!s.projectsOn && !s.ticketsOn) return 0;
  const prefix = meetingsPrefix(s); const fm = (f: TFile) => (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
  const files = new Map<string, TFile>(); const notes = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(prefix)) continue;
    const n = parseNote(f.path, fm(f), f.basename, ""); if (n) { notes.push(n); files.set(f.path, f); }
  }
  const { series } = buildSeries(notes, "");
  let changed = 0;
  const props = (path: string) => { const m = fm(files.get(path)!); return { assigned_project: rawLinks(m.assigned_project), assigned_ticket: rawLinks(m.assigned_ticket) }; };
  const out = (l: string[]) => l.length === 0 ? null : l.length === 1 ? `[[${l[0]}]]` : l.map(x => `[[${x}]]`);
  for (const sr of series) {
    const has = (p: ReturnType<typeof props>) => p.assigned_project.length > 0 || p.assigned_ticket.length > 0;
    const src = [...sr.instances].reverse().map(i => props(i.path)).find(has); if (!src) continue;
    for (const i of sr.instances) {
      if (has(props(i.path))) continue;
      await patchNote(app, files.get(i.path)!, { assigned_project: s.projectsOn ? out(src.assigned_project) : null, assigned_ticket: s.ticketsOn ? out(src.assigned_ticket) : null }); changed++;
    }
  }
  return changed;
}
