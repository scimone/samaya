// Pure helpers of the journal overview: what a note says in a line or two, and how notes are labelled and grouped.
import type { Period } from "./journal";
import { addDays, parseYmd, startOfWeek } from "./util";

export interface Digest { /** the first lines worth showing */ lines: string[]; finished: number; planned: number }

const stripFm = (t: string) => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
/** Plain text of a markdown line: links, emphasis and checkboxes removed. */
const plain = (t: string) => t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1").replace(/^\[[ xX]\]\s*/, "").replace(/\*\*|\*|`/g, "").trim();
const clip = (t: string) => (t.length > 160 ? t.slice(0, 157) + "…" : t);

/** The first lines of a note worth showing (no headings, tables or nested items) and, for a daily note, how many tasks it lists as finished and planned. Pure. */
export function digest(raw: string, p: Period, maxLines = 2): Digest {
  const secs = new Map<string, string[]>(); const flow: string[] = []; let head = "";
  for (const line of stripFm(raw).replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line); if (h) { head = h[1].trim(); continue; }
    if (/^\s/.test(line) || /^\|/.test(line) || /^-{3,}$/.test(line.trim())) continue; // nested items, table rows, rules
    const b = /^[-*+]\s+(.*)$/.exec(line);
    const t = clip(plain(b ? b[1].replace(/\s+•\s+.*$/, "") : line)); if (!t || /^none$/i.test(t)) continue;
    flow.push(t); if (b) { const l = secs.get(head) ?? []; l.push(t); secs.set(head, l); }
  }
  const find = (re: RegExp) => [...secs].filter(([h]) => re.test(h)).flatMap(([, v]) => v);
  const fin = find(/finish|done|complet/i), plan = find(/^(?!.*tomorrow).*plan/i);
  const lines = (p === "daily" ? (fin.length ? fin : plan.length ? plan : flow) : flow).slice(0, maxLines);
  return { lines, finished: p === "daily" ? fin.length : 0, planned: p === "daily" ? plan.length : 0 };
}

/** The date a note stands for: a weekly note parsed to a Sunday belongs to the week that starts the next day. Pure. */
export const anchor = (p: Period, date: string): string => (p === "weekly" && parseYmd(date).getDay() === 0 ? addDays(date, 1) : date);

/** Whether the note's period contains `ref` (YYYY-MM-DD). Pure. */
export function sameSpan(p: Period, date: string, ref: string): boolean {
  const a = anchor(p, date); const q = (d: string) => Math.floor((Number(d.slice(5, 7)) - 1) / 3);
  switch (p) {
    case "daily": return a === ref;
    case "weekly": return startOfWeek(a) === startOfWeek(ref);
    case "monthly": return a.slice(0, 7) === ref.slice(0, 7);
    case "quarterly": return a.slice(0, 4) === ref.slice(0, 4) && q(a) === q(ref);
    case "yearly": return a.slice(0, 4) === ref.slice(0, 4);
  }
}

/** The heading a note is listed under: the month for daily notes, the year for weekly, monthly and quarterly ones, none for yearly. Pure. */
export function groupLabel(p: Period, date: string): string {
  if (p === "yearly") return "";
  if (p === "daily") return parseYmd(date).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return anchor(p, date).slice(0, 4);
}

/** Row label and a quieter second line, e.g. "Thu 12 Nov", "Week 46" over its dates. `isoWeek` and `range` are passed in to keep this free of the heading code. Pure. */
export function rowLabel(p: Period, date: string, weekNo: (d: string) => number, range: (weekStart: string) => string): { main: string; sub: string } {
  const a = anchor(p, date); const d = parseYmd(a);
  switch (p) {
    case "daily": return { main: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), sub: "" };
    case "weekly": return { main: `Week ${weekNo(a)}`, sub: range(startOfWeek(a)) };
    case "monthly": return { main: d.toLocaleDateString(undefined, { month: "long" }), sub: "" };
    case "quarterly": return { main: `Q${Math.floor(d.getMonth() / 3) + 1}`, sub: "" };
    case "yearly": return { main: String(d.getFullYear()), sub: "" };
  }
}
