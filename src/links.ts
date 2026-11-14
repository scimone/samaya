// Keeps tasks, tickets and projects consistent (a project linked to a whole ticket project never hands out one of its tickets on its own): a task assigned to a ticket that belongs to a project is assigned to that project too, and the other way round.
import { App, TFile } from "obsidian";
import type { SamayaSettings } from "./settings";
import { Ticket, allTasks, allTickets, assignTicket, ticketPathOf } from "./model";
import { Project, assignProject, linkTickets, projectPathOf, readProject } from "./projects";

/** The Jira / GitLab project a project note is linked to as a whole ("" = none). */
const ticketProjectOf = (app: App, project: TFile): string => String(app.metadataCache.getFileCache(project)?.frontmatter?.ticket_project ?? "");
const fileAt = (app: App, path: string): TFile | null => { const f = path ? app.vault.getAbstractFileByPath(path) : null; return f instanceof TFile ? f : null; };

/** Assign a task to a ticket (or clear it); the ticket's project, if it has one, becomes the task's project. */
export async function assignTicketLinked(app: App, s: SamayaSettings, task: TFile, ticket: Ticket | null): Promise<void> {
  await assignTicket(app, task, ticket);
  const pf = ticket && s.projectsOn ? fileAt(app, projectPathOf(app, ticket.file)) : null;
  if (pf) await assignProject(app, task, readProject(app, pf));
}
/** Assign a task to a project (or clear it); if the project is linked to exactly one single ticket (not to a whole ticket project) and the task has none, that ticket becomes the task's ticket. */
export async function assignProjectLinked(app: App, s: SamayaSettings, task: TFile, project: Project | null): Promise<void> {
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
