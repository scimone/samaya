// Meeting notes grouped into series (recurring meetings) and one-offs. Pure: no Obsidian imports, unit-tested.
import { addDays, parseYmd } from "./util";
import { parseClock } from "./eventnotes";

export interface MeetingNote { path: string; title: string; date: string; start: number | null; end: number | null; /** the `is_recurring` property; undefined when the note has none */ recurring?: boolean; /** note text without frontmatter */ body: string; }
export type When = "past" | "today" | "upcoming";
export interface Instance extends MeetingNote { when: When; /** the first lines worth showing, without headings and empty bullets */ excerpt: string[]; hasNotes: boolean; open: number; done: number; }
export interface Series {
  key: string; title: string; hue: number;
  /** oldest first */
  instances: Instance[];
  cadence: string; days: string; time: string;
  held: number; withNotes: number; open: number;
  next?: Instance; last?: Instance;
}

/** Same series = same title, ignoring case, spacing and trailing blanks. */
export const seriesKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

export function hueOf(key: string): number { let h = 7; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }

export function stripFrontmatter(text: string): string { return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); }

/** What a meeting note says: the first few real lines, and the open / done action items. */
export function analyse(body: string, maxLines = 3): { excerpt: string[]; open: number; done: number } {
  const excerpt: string[] = []; let open = 0, done = 0;
  for (const raw of body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^-{3,}$/.test(line)) continue;
    const task = /^[-*]\s+\[( |x|X)\]\s*(.*)$/.exec(line);
    if (task && !task[2].trim()) continue;
    if (task) { if (task[1] === " ") open++; else done++; }
    const text = line.replace(/^[-*+]\s+(\[[ xX]\]\s*)?/, "").replace(/^\d+\.\s+/, "").trim();
    if (!text) continue;
    if (excerpt.length < maxLines) excerpt.push(text.length > 160 ? text.slice(0, 157) + "…" : text);
  }
  return { excerpt, open, done };
}

const DAY = 86400000;
const gapDays = (a: string, b: string) => Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / DAY);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How often a series meets, from the gaps between its dates: label ("Weekly") and the weekdays ("Tue"). */
export function cadenceOf(dates: string[]): { label: string; days: string } {
  const ds = [...new Set(dates)].sort();
  if (ds.length < 2) return { label: "Recurring", days: ds.length ? WD[parseYmd(ds[0]).getDay()] : "" };
  const gaps = ds.slice(1).map((d, i) => gapDays(ds[i], d)).sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  let label: string;
  if (med <= 1) label = "Daily"; else if (med === 2) label = "3× a week"; else if (med <= 4) label = "2× a week";
  else if (med <= 9) label = "Weekly"; else if (med <= 18) label = "Every 2 weeks"; else if (med <= 24) label = "Every 3 weeks"; else if (med <= 35) label = "Monthly"; else label = `Every ${med} days`;
  const wds = [...new Set(ds.map(d => parseYmd(d).getDay()))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const days = label === "Daily" ? "Mon–Fri" : wds.length <= 3 ? wds.map(d => WD[d]).join(", ") : "";
  return { label, days };
}

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** The usual time slot: the most common "09:30–10:00" among the instances. */
export function usualTime(list: Array<Pick<MeetingNote, "start" | "end">>): string {
  const count = new Map<string, number>();
  for (const n of list) if (n.start != null) { const k = n.end != null ? `${hm(n.start)}–${hm(n.end)}` : hm(n.start); count.set(k, (count.get(k) ?? 0) + 1); }
  let best = "", n = 0; for (const [k, c] of count) if (c > n) { best = k; n = c; }
  return best;
}

/** A meeting today whose time frame is over counts as past; `nowMin` = minutes after midnight (-1: ignore the time of day). */
export function whenOf(n: Pick<MeetingNote, "date" | "start" | "end">, today: string, nowMin = -1): When {
  if (n.date < today) return "past";
  if (n.date > today) return "upcoming";
  const over = n.end ?? n.start;
  return over != null && over <= nowMin ? "past" : "today";
}

export function toInstance(n: MeetingNote, today: string, nowMin = -1): Instance {
  const a = analyse(n.body);
  return { ...n, when: whenOf(n, today, nowMin), excerpt: a.excerpt, hasNotes: a.excerpt.length > 0, open: a.open, done: a.done };
}

/** Recurring notes (`is_recurring: true`) form a series per title; one-offs stay single. Without the property, a title that occurs more than once counts as recurring. */
export function buildSeries(notes: MeetingNote[], today: string, nowMin = -1): { series: Series[]; oneOffs: Instance[] } {
  const byKey = new Map<string, MeetingNote[]>();
  for (const n of notes) { const k = seriesKey(n.title); const l = byKey.get(k); if (l) l.push(n); else byKey.set(k, [n]); }
  const series: Series[] = []; const oneOffs: Instance[] = [];
  for (const [key, list] of byKey) {
    const flagged = list.some(n => n.recurring === true);
    const unflagged = list.every(n => n.recurring === undefined) && list.length > 1;
    if (!flagged && !unflagged) { for (const n of list) oneOffs.push(toInstance(n, today, nowMin)); continue; }
    const inst = list.map(n => toInstance(n, today, nowMin)).sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0));
    const past = inst.filter(i => i.when !== "upcoming");
    const cad = cadenceOf(inst.map(i => i.date));
    series.push({
      key, title: inst[inst.length - 1].title.trim(), hue: hueOf(key), instances: inst, cadence: cad.label, days: cad.days, time: usualTime(inst),
      held: inst.filter(i => i.when === "past").length, withNotes: inst.filter(i => i.when === "past" && i.hasNotes).length, open: inst.reduce((s, i) => s + i.open, 0),
      next: inst.find(i => i.when !== "past"), last: past[past.length - 1],
    });
  }
  oneOffs.sort((a, b) => b.date.localeCompare(a.date));
  return { series, oneOffs };
}

export function parseNote(path: string, fm: Record<string, unknown> | undefined, basename: string, body: string): MeetingNote | null {
  if (!fm) return null;
  const nameDate = /^(\d{4}-\d{2}-\d{2})/.exec(basename)?.[1];
  const date = fm.date == null ? nameDate : String(fm.date).slice(0, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const r = fm.is_recurring; const recurring = r == null ? undefined : r === true || /^(true|yes|1)$/i.test(String(r));
  return { path, title: String(fm.title ?? basename).trim() || basename, date, start: parseClock(fm.start), end: parseClock(fm.end), recurring, body: stripFrontmatter(body) };
}

/** "in 25 min", "in 3 h", "Tomorrow", "Thu 12 Nov" for the up-next strip. */
export function untilLabel(date: string, startMin: number | null, today: string, nowMin: number, weekdayDate: (d: string) => string): string {
  if (date === today) {
    if (startMin == null) return "Today";
    const d = startMin - nowMin;
    return d <= 0 ? "Now" : d < 60 ? `in ${d} min` : `in ${Math.round(d / 60)} h`;
  }
  if (date === addDays(today, 1)) return "Tomorrow";
  return weekdayDate(date);
}
