// Calendar events from existing Obsidian notes Pure: no Obsidian imports, unit-tested.
export interface CalendarEvent { title: string; start: Date; end: Date; allDay: boolean; /** the note this event is */ notePath?: string; }

export const DEFAULT_EVENT_PATTERN = "{{date}}_{{title}}";
export const PATTERN_HELP = "Placeholders: {{date}} = yyyy-mm-dd, {{title}} = free text, {{start}} = start time as hhmm / hh-mm / hh:mm. Example: {{date}}_{{title}}";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PART: Record<string, string> = { date: "(\\d{4}-\\d{2}-\\d{2})", title: "(.+?)", start: "(\\d{2}[-.:h]?\\d{2})" };

/** Compile a file-name pattern (without .md) into a matcher. Returns null for an unusable pattern. */
export function compilePattern(pattern: string): ((basename: string) => { date?: string; title?: string; start?: string } | null) | null {
  const keys: string[] = []; let src = "";
  const re = /\{\{(date|title|start)\}\}/g; let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(pattern))) { src += esc(pattern.slice(last, m.index)) + PART[m[1]]; keys.push(m[1]); last = m.index + m[0].length; }
  src += esc(pattern.slice(last));
  if (/\{\{|\}\}/.test(pattern.replace(re, ""))) return null; // unknown placeholder
  const rx = new RegExp(`^${src}$`);
  return name => {
    const r = rx.exec(name); if (!r) return null;
    const out: { date?: string; title?: string; start?: string } = {};
    keys.forEach((k, i) => { (out as Record<string, string>)[k] = r[i + 1]; });
    return out;
  };
}

/** "9:30", "0930", "09-30", "09:30:00" -> minutes after midnight. */
export function parseClock(v: unknown): number | null {
  if (v == null) return null;
  const m = String(v).trim().match(/^(\d{1,2})[-.:h]?(\d{2})(?::\d{2})?$/);
  if (!m) return null; const h = +m[1], mi = +m[2];
  return h > 24 || mi > 59 ? null : h * 60 + mi;
}
function parseStamp(v: unknown): { date?: string; min: number } | null {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](.+)$/);
  if (m) { const min = parseClock(m[2]); return min == null ? null : { date: m[1], min }; }
  const min = parseClock(s); return min == null ? null : { min };
}
const truthy = (v: unknown) => v === true || /^(true|yes|1)$/i.test(String(v ?? ""));
const at = (date: string, min: number) => { const [y, mo, d] = date.split("-").map(Number); return new Date(y, mo - 1, d, 0, min); };

/**
 * Build an event from a note's frontmatter + the values parsed from its file name.
 * Needs `start` and `end` (hh:mm, or yyyy-mm-dd hh:mm). The day comes from `date` or the file name (or the start stamp).
 * `allday: true` needs only the date. `title` is optional (falls back to the name's {{title}}, then the file name).
 */
export function eventFromNote(fm: Record<string, unknown> | undefined, name: { date?: string; title?: string; start?: string }, basename: string): CalendarEvent | null {
  if (!fm) return null;
  const title = String(fm.title ?? name.title ?? basename).trim() || basename;
  const dateProp = fm.date == null ? undefined : String(fm.date).slice(0, 10);
  const allDay = truthy(fm.allday ?? fm.allDay);
  const st = parseStamp(fm.start ?? (allDay ? undefined : name.start));
  const en = parseStamp(fm.end);
  const date = (st?.date) ?? dateProp ?? name.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (allDay) return { title, start: at(date, 0), end: at(date, 1440), allDay: true };
  if (!st || !en) return null;
  const start = at(date, st.min);
  let end = at(en.date ?? date, en.min);
  if (end <= start) end = en.date ? end : new Date(end.getTime() + 86400000); // time-only end before start = next day
  if (end <= start) return null;
  return { title, start, end, allDay: false };
}
