// Pure parser for the quick-add line (no Obsidian imports, unit-tested).
//
//   Write report 1h30m @tomorrow #website &PROJ-123 /standup
//
//   25m / 1h / 1.5h / 1h30m   estimate
//   @today @tomorrow @mon..@sun @2026-11-20 @+3     the day it is planned for
//   @week                                           this week, no day yet
//   @nextweek @month @quarter @year @someday @never  parked in the backlog
//   #project   &ticket-key   /meeting               links (names are matched loosely; "-" stands for a space)
//
// Directives can stand anywhere in the line (the estimate only at its end); the title is what is left.
// A directive that should stay part of the title is written with a backslash: \#5
import { Horizon, addDays, isHorizon, parseYmd, startOfWeek, today } from "./util";

export type When = { day: string } | { week: string } | { horizon: Horizon };
export interface QuickTask { title: string; estimate?: number; when?: When; project?: string; ticket?: string; meeting?: string; /** meeting date when given as /name:yyyy-mm-dd */ meetingDate?: string; errors: string[]; }

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const HORIZON_WORDS: Record<string, Horizon> = { nextweek: "week", "next-week": "week", month: "month", nextmonth: "month", quarter: "quarter", nextquarter: "quarter", year: "year", nextyear: "year", someday: "someday", never: "never" };
/** Words offered after "@" and what they mean (also the suggestions in the quick-add dialog). */
export const WHEN_WORDS: Array<[string, string]> = [
  ["today", "Today"], ["tomorrow", "Tomorrow"], ["mon", "Next Monday"], ["tue", "Next Tuesday"], ["wed", "Next Wednesday"], ["thu", "Next Thursday"], ["fri", "Next Friday"], ["sat", "Next Saturday"], ["sun", "Next Sunday"],
  ["week", "This week (no day yet)"], ["nextweek", "Backlog: next week"], ["month", "Backlog: next month"], ["quarter", "Backlog: next quarter"], ["year", "Backlog: next year"], ["someday", "Backlog: someday"], ["never", "Backlog: never"],
];

const DUR = /^(?:(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hours?)(?:(\d+)\s*m?)?|(\d+)\s*(?:m|min|mins)|(\d+):(\d{2}))$/i;
/** "25m", "1.5h", "1h30m", "1:30" -> minutes; null when the token is not a duration. */
export function durationToken(t: string): number | null {
  const m = t.match(DUR); if (!m) return null;
  if (m[1] !== undefined) return Math.round(parseFloat(m[1].replace(",", ".")) * 60) + (m[2] ? +m[2] : 0);
  if (m[3] !== undefined) return +m[3];
  return +m[4] * 60 + +m[5];
}

/** Day or backlog bucket a "@word" stands for; null when it is none. */
export function whenToken(word: string, from: string): When | null {
  const w = word.toLowerCase(); let m: RegExpMatchArray | null;
  if (w === "today" || w === "tod") return { day: from };
  if (w === "tomorrow" || w === "tmr" || w === "tom") return { day: addDays(from, 1) };
  if (w === "week" || w === "thisweek") return { week: startOfWeek(from) };
  if (HORIZON_WORDS[w]) return { horizon: HORIZON_WORDS[w] };
  if (isHorizon(w)) return { horizon: w };
  if ((m = w.match(/^\+(\d{1,3})d?$/))) return { day: addDays(from, +m[1]) };
  if ((m = w.match(/^(\d{4}-\d{2}-\d{2})$/))) { const d = parseYmd(m[1]); return d.getMonth() + 1 === +m[1].slice(5, 7) ? { day: m[1] } : null; }
  const di = w.length >= 3 ? DAYS.findIndex(d => d.startsWith(w)) : -1;
  if (di >= 0) { const cur = parseYmd(from).getDay(); return { day: addDays(from, ((di - cur + 6) % 7) + 1) }; } // the next one, never today
  return null;
}

type Kind = "when" | "project" | "ticket" | "meeting" | "dur";
const PREFIX: Record<string, Kind> = { "@": "when", "#": "project", "&": "ticket", "/": "meeting" };
function kindOf(t: string): Kind | null {
  if (t.length > 1 && PREFIX[t[0]]) return PREFIX[t[0]];
  return durationToken(t) !== null ? "dur" : null;
}

export function parseQuick(raw: string, from = today()): QuickTask {
  const out: QuickTask = { title: "", errors: [] };
  const toks = raw.trim().split(/\s+/).filter(Boolean);
  const used = toks.map(t => { const k = kindOf(t); return k !== null && k !== "dur"; }); // @ # & / words count wherever they stand
  const bare = (t: string) => !/[\p{L}\p{N}]/u.test(t); // a lone ( or / being typed: it neither is a directive nor ends the search for the estimate
  for (let j = toks.length - 1; j >= 0; j--) { // the estimate: at the end, behind any directives and loose signs
    if (kindOf(toks[j]) === "dur") used[j] = true; else if (!used[j] && !bare(toks[j])) break;
  }
  for (const t of toks.filter((_, i) => used[i])) {
    const k = kindOf(t)!; const v = t.slice(1);
    if (k === "dur") { out.estimate = durationToken(t)!; continue; }
    if (k === "when") { const w = whenToken(v, from); if (w) out.when = w; else out.errors.push(`Unknown date "${t}"`); continue; }
    if (k === "meeting") { const m = v.match(/^(.*?):(\d{4}-\d{2}-\d{2})$/); out.meeting = m ? m[1] : v; out.meetingDate = m?.[2]; continue; }
    out[k] = v;
  }
  out.title = toks.filter((_, i) => !used[i]).map(t => t.replace(/^\\(?=[@#&/])/, "")).join(" ");
  if (!out.title) out.errors.push("The task needs a title");
  return out;
}

/** The directive being typed at the end of `text` up to `cursor` ("" prefix when none): what the dialog completes. */
export function tokenAt(text: string, cursor: number): { start: number; end: number; prefix: string; query: string } | null {
  let s = cursor; while (s > 0 && !/\s/.test(text[s - 1])) s--;
  let e = cursor; while (e < text.length && !/\s/.test(text[e])) e++;
  const tok = text.slice(s, e);
  if (tok.length < 1 || !PREFIX[tok[0]] || PREFIX[tok[0]] === "dur") return null;
  return { start: s, end: e, prefix: tok[0], query: tok.slice(1) };
}
