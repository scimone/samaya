// "Tasks" section of project and ticket notes: every task assigned to the note, in the style of the daily note's planned tasks plus the day.
import { App, TFile } from "obsidian";
import type { SamayaSettings } from "./settings";
import { Task, allTasks, meetingPathOf, prefixOf, ticketPathOf } from "./model";
import { JournalTask, plannedTime, taskLines, upsertSection } from "./journal";
import { allProjects, projectPathOf, projectsPrefix } from "./projects";
import { meetingsPrefix } from "./links";

export const TASKS_HEADING = "Tasks";

/** The section body for a note's tasks: planned ones by day and time first, then the others. Pure apart from reading the task. */
export function taskListBody(tasks: Task[]): string {
  const sorted = [...tasks].sort((a, b) => (a.planned || "9999").localeCompare(b.planned || "9999") || (a.start || "99:99").localeCompare(b.start || "99:99") || a.title.localeCompare(b.title));
  const items: JournalTask[] = sorted.map(t => ({ title: t.title, minutes: t.estimate, subtasks: [], day: t.planned || undefined, time: plannedTime(t) }));
  return taskLines(items);
}

/** Notes (path -> tasks) that get a Tasks section: projects while projects are on, tickets while Jira or GitLab is on, and meetings that have tasks assigned (or already show the section). */
export async function syncTaskLists(app: App, s: SamayaSettings): Promise<void> {
  const projectsOn = s.projectsOn, ticketsOn = s.ticketsOn;
  const byNote = new Map<string, Task[]>();
  if (projectsOn) for (const p of allProjects(app, s)) byNote.set(p.file.path, []);
  if (ticketsOn) { const tp = prefixOf(s.ticketsPath); if (tp) for (const f of app.vault.getMarkdownFiles()) if (f.path.startsWith(tp)) byNote.set(f.path, []); }
  const mp = meetingsPrefix(s);
  for (const f of app.vault.getMarkdownFiles()) if (f.path.startsWith(mp) && app.metadataCache.getFileCache(f)?.headings?.some(h => h.level === 2 && h.heading.trim() === TASKS_HEADING)) byNote.set(f.path, []); // a section whose tasks were all unlinked is emptied
  for (const t of allTasks(app, s)) {
    const targets = new Set<string>();
    const m = meetingPathOf(app, t); if (m && m.startsWith(mp)) { if (!byNote.has(m)) byNote.set(m, []); targets.add(m); }
    if (projectsOn) { const p = projectPathOf(app, t.file); if (p) targets.add(p); }
    if (ticketsOn) { const p = ticketPathOf(app, t); if (p) targets.add(p); }
    for (const p of targets) byNote.get(p)?.push(t);
  }
  for (const [path, tasks] of byNote) {
    const f = app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) continue;
    const body = taskListBody(tasks);
    await app.vault.process(f, text => { const next = upsertSection(text, TASKS_HEADING, body, [TASKS_HEADING]); return next === text ? text : next; });
  }
}

/** Whether a file is one whose changes can alter a Tasks section. */
export const affectsTaskLists = (s: SamayaSettings, path: string): boolean => {
  const tp = prefixOf(s.tasksPath);
  const kp = prefixOf(s.ticketsPath);
  return (!tp || path.startsWith(tp)) && !path.startsWith(projectsPrefix(s)) && !(kp && path.startsWith(kp));
};
