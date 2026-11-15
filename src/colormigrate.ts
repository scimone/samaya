// Gives colours to what has none: projects, and ticket projects (one colour each). Safe to run again; also removes the per-ticket `color` of an earlier version.
import { App } from "obsidian";
import type { SamayaSettings } from "./settings";
import { COLOR_PROP, noteColor, randomColor, savePersisted, ticketProjectColor, writeNoteColor } from "./itemcolor";
import { allProjects } from "./projects";
import { allTickets, patchNote } from "./model";

export async function ensureColors(app: App, s: SamayaSettings): Promise<void> {
  const projects = s.projectsOn ? allProjects(app, s) : [];
  const used = projects.map(p => noteColor(app, p.file)).filter(Boolean);
  for (const p of projects) if (!noteColor(app, p.file)) { const c = randomColor(used); used.push(c); await writeNoteColor(app, p.file, c); }
  if (!s.ticketsOn) return;
  const tickets = allTickets(app, s);
  const linked = new Map(projects.map(p => [String(app.metadataCache.getFileCache(p.file)?.frontmatter?.ticket_project ?? ""), p] as const).filter(([k]) => k)); // ticket project -> the project made from it
  const keys = [...new Set(tickets.map(t => t.project).filter(Boolean))].sort();
  const usedTp = Object.values(s.ticketProjectColors); let changed = false;
  for (const k of keys) {
    if (ticketProjectColor(s, k)) continue;
    const owner = linked.get(k); const own = owner ? noteColor(app, owner.file) || undefined : undefined;
    const c = own ?? randomColor([...usedTp, ...used]); usedTp.push(c); s.ticketProjectColors[k] = c; changed = true;
  }
  if (changed) await savePersisted();
  for (const t of tickets) if (app.metadataCache.getFileCache(t.file)?.frontmatter?.[COLOR_PROP] !== undefined) await patchNote(app, t.file, { [COLOR_PROP]: null });
}
