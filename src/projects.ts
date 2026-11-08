// Projects: one note per project in the projects folder; tasks and tickets point at one with `samaya_project`.
import { App, TFile, normalizePath } from "obsidian";
import type { SamayaSettings } from "./settings";
import { ensureFolder, patchTask } from "./model";
import { Span, parseSpan } from "./gantt";
import { addDays, safeFileName, today } from "./util";

export const PROJECT_PROP = "samaya_project";
export const DEFAULT_PROJECT_DAYS = 14;

export interface Project { file: TFile; name: string; span: Span | null; done: boolean; }

const folderOf = (s: SamayaSettings): string => normalizePath(s.projectsPath.trim() || "Projects");
export const projectsPrefix = (s: SamayaSettings): string => folderOf(s) + "/";

export function readProject(app: App, file: TFile): Project {
  const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
  return { file, name: file.basename, span: parseSpan(fm.start, fm.end), done: fm.status === "done" };
}
export function allProjects(app: App, s: SamayaSettings): Project[] {
  const prefix = projectsPrefix(s);
  return app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(f => readProject(app, f)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Path of the project note a task / ticket note points at ("" = none). */
export function projectPathOf(app: App, file: TFile): string {
  const raw = (app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined)?.[PROJECT_PROP];
  const link = String(raw ?? "").replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
  return link ? app.metadataCache.getFirstLinkpathDest(link, file.path)?.path ?? "" : "";
}
export async function assignProject(app: App, file: TFile, project: Project | null): Promise<void> {
  await patchTask(app, file, { [PROJECT_PROP]: project ? `[[${project.file.basename}]]` : null });
}

/** Per project (by note path): linked tasks, how many are done, and linked tickets. */
export function projectStats(app: App, tasksPrefix: string, ticketsPrefix: string): Map<string, { tasks: number; done: number; tickets: number }> {
  const out = new Map<string, { tasks: number; done: number; tickets: number }>();
  for (const f of app.vault.getMarkdownFiles()) {
    const isTask = f.path.startsWith(tasksPrefix), isTicket = !isTask && f.path.startsWith(ticketsPrefix);
    if (!isTask && !isTicket) continue;
    const p = projectPathOf(app, f); if (!p) continue;
    const st = out.get(p) ?? { tasks: 0, done: 0, tickets: 0 }; out.set(p, st);
    if (isTicket) st.tickets++;
    else { st.tasks++; if (app.metadataCache.getFileCache(f)?.frontmatter?.status === "done") st.done++; }
  }
  return out;
}

/** New project note starting today and running two weeks. */
export async function createProject(app: App, s: SamayaSettings, name: string): Promise<TFile> {
  const folder = folderOf(s); await ensureFolder(app, folder);
  const base = safeFileName(name); let path = `${folder}/${base}.md`; let i = 2;
  while (app.vault.getAbstractFileByPath(path)) path = `${folder}/${base} ${i++}.md`;
  const f = await app.vault.create(path, "");
  const start = today();
  await patchTask(app, f, { status: "active", start, end: addDays(start, DEFAULT_PROJECT_DAYS - 1) });
  return f;
}

export const PROJECTS_BASE_TEMPLATE = (folder: string, ganttType: string) => `filters:
  and:
    - file.inFolder("${folder}")
properties:
  note.start:
    displayName: Start
  note.end:
    displayName: End
views:
  - type: ${ganttType}
    name: Gantt
  - type: table
    name: All projects
    order:
      - file.name
      - status
      - start
      - end
    sort:
      - property: start
        direction: ASC
`;
