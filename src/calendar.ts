import { normalizePath } from "obsidian";
import type SamayaPlugin from "./main";
import type { SamayaSettings } from "./settings";
import { DEFAULT_EVENT_PATTERN, compilePattern, eventFromNote, type CalendarEvent } from "./eventnotes";

export const calendarEnabled = (s: SamayaSettings) => s.calendarOn && !!s.eventNotesFolder;
export const inEventFolder = (s: SamayaSettings, path: string) => s.calendarOn && path.startsWith(normalizePath(s.eventNotesFolder) + "/");

/** Every event note, parsed once: the planner and the meeting banner ask for events on every redraw / poll, and scanning the whole vault each time is wasteful. */
let index: { key: string; events: CalendarEvent[] } | null = null;
/** Call when an event note may have changed (create / edit / rename / delete). The next query rebuilds the index. */
export function invalidateCalendar(): void { index = null; }

function allEvents(plugin: SamayaPlugin): CalendarEvent[] {
  const s = plugin.settings; const pattern = s.eventNotePattern || DEFAULT_EVENT_PATTERN;
  const key = `${s.calendarOn}|${s.eventNotesFolder}|${pattern}`;
  if (index && index.key === key) return index.events;
  const match = compilePattern(pattern); const events: CalendarEvent[] = [];
  if (match) for (const f of plugin.app.vault.getMarkdownFiles()) {
    if (!inEventFolder(s, f.path)) continue;
    const name = match(f.basename); if (!name) continue;
    const ev = eventFromNote(plugin.app.metadataCache.getFileCache(f)?.frontmatter, name, f.basename);
    if (ev) events.push({ ...ev, notePath: f.path });
  }
  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  index = { key, events };
  return events;
}

/** Events overlapping [from, to) from the configured source (existing notes). */
export async function calendarEvents(plugin: SamayaPlugin, from: Date, to: Date): Promise<CalendarEvent[]> {
  return allEvents(plugin).filter(ev => ev.end > from && ev.start < to).map(ev => ({ ...ev }));
}
