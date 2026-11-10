export function pad(n: number): string { return n < 10 ? "0" + n : String(n); }
export function ymd(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function parseYmd(s: string): Date { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
export function today(): string { return ymd(new Date()); }
export function addDays(s: string, n: number): string { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
export function startOfWeek(s: string, mondayFirst = true): string {
  const d = parseYmd(s); const dow = d.getDay();
  const diff = mondayFirst ? (dow + 6) % 7 : dow; d.setDate(d.getDate() - diff); return ymd(d);
}
/** Backlog buckets: tasks parked until next week, next month or next quarter. */
export type Horizon = "week" | "month" | "quarter";
export const HORIZONS: Array<[Horizon, string]> = [["week", "Next week"], ["month", "Next month"], ["quarter", "Next quarter"]];
/** Date a task parked in `h` becomes due (start of next week / month / quarter), counted from `from`. */
export function horizonTarget(h: Horizon, from: string): string {
  if (h === "week") return addDays(startOfWeek(from), 7);
  const d = parseYmd(from);
  if (h === "month") return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  return ymd(new Date(d.getFullYear(), (Math.floor(d.getMonth() / 3) + 1) * 3, 1));
}
/** Bucket a parked task currently shows in: closer targets cascade (a "next month" task whose date falls in next week shows under Next week). */
export function horizonOf(later: string, from: string): Horizon {
  if (later <= addDays(startOfWeek(from), 13)) return "week";
  const d = parseYmd(from);
  return later < ymd(new Date(d.getFullYear(), d.getMonth() + 2, 1)) ? "month" : "quarter";
}
export function hmToMin(hm: string): number { const [h, m] = hm.split(":").map(Number); return h * 60 + (m || 0); }
export function minToHm(min: number): string { const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min))); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
export function fmtDur(min: number): string {
  if (!min) return "0m"; const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
export function parseTitleEstimate(raw: string): { title: string; estimate?: number } {
  const m = raw.trim().match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*(m|min|h|hr)$/i);
  if (!m || !m[1].trim()) return { title: raw.trim() };
  const v = parseFloat(m[2]); const est = /^h/i.test(m[3]) ? Math.round(v * 60) : Math.round(v);
  return { title: m[1].trim(), estimate: est };
}
export function safeFileName(s: string): string { return s.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim() || "Untitled"; }
export function fmtHm(min: number): string { const m = Math.max(0, Math.round(min)); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
/** "1:30", "1.5h", "90m", "90" -> minutes; null if unparsable. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase(); let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*h(?:r|ours?)?$/))) return Math.round(parseFloat(m[1].replace(",", ".")) * 60);
  if ((m = s.match(/^(\d+)\s*(?:m|min)?$/))) return +m[1];
  return null;
}
export function slugify(s: string, fallback = "meeting"): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || fallback;
}

export class Emitter {
  private subs = new Set<() => void>();
  on(cb: () => void): () => void { this.subs.add(cb); return () => this.subs.delete(cb); }
  emit() { this.subs.forEach(cb => cb()); }
}
