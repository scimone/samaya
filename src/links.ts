// Keeps tasks, tickets and projects consistent (a project linked to a whole ticket project never hands out one of its tickets on its own): a task assigned to a ticket that belongs to a project is assigned to that project too, and the other way round.
import { App, Notice, TFile } from "obsidian";
import type { SamayaSettings } from "./settings";
import { Ticket, allTasks, allTickets, assignTicket, readTask, ticketPathOf } from "./model";
import { Project, allProjects, assignProject, linkTickets, projectPathOf, readProject } from "./projects";

/** The Jira / GitLab project a project note is linked to as a whole ("" = none). */
const ticketProjectOf = (app: App, project: TFile): string => String(app.metadataCache.getFileCache(project)?.frontmatter?.ticket_project ?? "");
const fileAt = (app: App, path: string): TFile | null => { const f = path ? app.vault.getAbstractFileByPath(path) : null; return f instanceof TFile ? f : null; };

/** The project a ticket belongs to (path, "" = none): the one its note points at, else the one linked to the ticket's whole Jira / GitLab project. */
export function ownerProjectOf(app: App, s: SamayaSettings, ticket: Ticket): string {
  const direct = projectPathOf(app, ticket.file); if (direct) return direct;
  return ticket.project ? allProjects(app, s).find(p => String(app.metadataCache.getFileCache(p.file)?.frontmatter?.ticket_project ?? "") === ticket.project)?.file.path ?? "" : "";
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
  const linked = new Map(allTickets(app, s).filter(t => projectPathOf(app, t.file) === project.path).map(t => [t.file.path, t] as const));
  for (const t of tickets) linked.set(t.file.path, t); // the cache may not have caught up with the notes just written
  const only = linked.size === 1 && !ticketProject && !ticketProjectOf(app, project) ? [...linked.values()][0] : null;
  const pr = readProject(app, project);
  for (const t of allTasks(app, s)) {
    if (t.ticket && linked.has(ticketPathOf(app, t))) { if (projectPathOf(app, t.file) !== project.path) await assignProject(app, t.file, pr); }
    else if (!t.ticket && only && projectPathOf(app, t.file) === project.path) await assignTicket(app, t.file, only);
  }
}
