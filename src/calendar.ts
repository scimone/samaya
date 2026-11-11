import { normalizePath } from "obsidian";
import type SamayaPlugin from "./main";
import type { SamayaSettings } from "./settings";
import { DEFAULT_EVENT_PATTERN, compilePattern, eventFromNote, type CalendarEvent } from "./eventnotes";

export const calendarEnabled = (s: SamayaSettings) => s.calendarOn && !!s.eventNotesFolder;
export const inEventFolder = (s: SamayaSettings, path: string) => s.calendarOn && path.startsWith(normalizePath(s.eventNotesFolder) + "/");

/** Events overlapping [from, to) from the configured source (existing notes). */
export async function calendarEvents(plugin: SamayaPlugin, from: Date, to: Date): Promise<CalendarEvent[]> {
  const s = plugin.settings;
  const match = compilePattern(s.eventNotePattern || DEFAULT_EVENT_PATTERN); if (!match) return [];
  const out: CalendarEvent[] = [];
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    if (!inEventFolder(s, f.path)) continue;
    const name = match(f.basename); if (!name) continue;
    const ev = eventFromNote(plugin.app.metadataCache.getFileCache(f)?.frontmatter, name, f.basename);
    if (ev && ev.end > from && ev.start < to) out.push({ ...ev, notePath: f.path });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
