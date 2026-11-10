// Daily note ("Journal") sections written by the planning and shutdown rituals.
import { App, TFile, normalizePath } from "obsidian";
import type { SamayaSettings } from "./settings";
import { renderPath, renderTemplate } from "./taskbody";
import { Task, ensureFolder, loadTemplate, momentFmt, readSubtasks, rootOf } from "./model";
import { hmToMin, minToHm, today } from "./util";
import { fmtSegments } from "./segments";
import { BUFFER_SHARE, loadLevel } from "./weekplan";

export type JournalPart = "journalPlanned" | "journalFinished" | "journalTomorrow" | "journalWorkTimes" | "journalBreaks" | "journalTracked" | "journalWeekPlan" | "journalWeekMeetings" | "journalWeekTasks";
/** Whether the journal module is on and the given part of it is enabled. */
export const journalWants = (s: SamayaSettings, part: JournalPart): boolean => s.journalOn && s[part];

export const SECTIONS = ["Meetings", "Planned tasks", "Finished tasks", "Planned for tomorrow"] as const;
export type Section = typeof SECTIONS[number];
/** The weekly note's sections the week plan writes, in order; "Weekly review" is added later and comes last. */
export const WEEK_OVERVIEW = "Overview", WEEK_MEETINGS = "Meetings", WEEK_TASKS = "Planned tasks";
export const WEEK_ORDER = [WEEK_OVERVIEW, WEEK_MEETINGS, WEEK_TASKS, "Weekly review"] as const;
/** Headings of earlier versions of the week plan (a "Weekly plan" section with weekdays below it, or one section per weekday) that are replaced. */
export const LEGACY_WEEK_HEADINGS = ["Weekly plan", "Week plan", "No day yet"];
/** Remove `## heading` and its body (nothing happens when it is missing). Pure. */
export function removeSection(text: string, heading: string): string {
  const lines = text.split("\n"); const isH = (l: string) => /^##\s+/.test(l);
  const i = lines.findIndex(l => isH(l) && l.trim().replace(/^##\s+/, "") === heading); if (i < 0) return text;
  let end = i + 1; while (end < lines.length && !isH(lines[end])) end++;
  lines.splice(i, end - i); return lines.join("\n");
}

export function fmtEstimate(min: number): string {
  if (!min || min <= 0) return "";
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60; return `${Number.isInteger(h) ? h : +h.toFixed(2)} hr`;
}

export interface JournalTask { title: string; minutes: number; subtasks: string[]; /** planned time of day, e.g. "10:00-10:30" */ time?: string; /** weekly note: the weekday ("no day" when unscheduled) */ day?: string; }

export function taskLines(items: JournalTask[]): string {
  if (!items.length) return "- None";
  return items.map(t => {
    const est = fmtEstimate(t.minutes);
    return [`- [[${t.title}]]${t.day ? ` • ${t.day}` : ""}${t.time ? ` • *${t.time}*` : ""}${est ? ` • *${est}*` : ""}`, ...t.subtasks.map(s => `    - ${s}`)].join("\n");
  }).join("\n");
}
/** One bullet per meeting: "HH:MM-HH:MM Title" (linked to the meeting note when there is one; all-day events: "All day Title"). Pure. */
export function meetingLines(events: Array<{ title: string; start: Date; end: Date; allDay: boolean; /** note basename to link to */ note?: string }>): string {
  if (!events.length) return "- None";
  const hm = (d: Date) => minToHm(d.getHours() * 60 + d.getMinutes());
  return events.map(e => `- ${e.allDay ? "*All day*" : `*${hm(e.start)}-${hm(e.end)}*`} ${e.note ? `[[${e.note}|${e.title}]]` : e.title}`).join("\n");
}
export function bulletLines(lines: string[]): string {
  const l = lines.map(x => x.trim().replace(/^[-*]\s+/, "")).filter(Boolean);
  return l.length ? l.map(x => `- ${x}`).join("\n") : "- None";
}

/** Replace the body of `## heading` (or insert it in canonical order). Pure. */
export function upsertSection(text: string, heading: string, body: string, order: readonly string[] = SECTIONS): string {
  const lines = text.split("\n");
  const isH = (l: string) => /^##\s+/.test(l);
  const find = (h: string) => lines.findIndex(l => l.trim().replace(/^##\s+/, "") === h && isH(l));
  const idx = find(heading);
  const block = [`## ${heading}`, "", ...body.split("\n"), ""];
  if (idx >= 0) {
    let end = idx + 1; while (end < lines.length && !isH(lines[end])) end++;
    lines.splice(idx, end - idx, ...block);
    return lines.join("\n");
  }
  const myPos = order.indexOf(heading);
  let insertAt = -1;
  for (let k = myPos + 1; k < order.length && insertAt < 0; k++) insertAt = find(order[k]);
  if (insertAt < 0) {
    const base = text.replace(/\s+$/, "");
    return (base ? base + "\n\n" : "") + block.join("\n");
  }
  lines.splice(insertAt, 0, ...block);
  return lines.join("\n");
}
export function readSection(text: string, heading: Section): string[] {
  const lines = text.split("\n");
  const i = lines.findIndex(l => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim() === heading);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && !/^##\s+/.test(lines[j]); j++) if (lines[j].trim()) out.push(lines[j].replace(/^[-*]\s+/, ""));
  return out.filter(x => x !== "None");
}

export type JournalSource = "daily" | "periodic" | "custom";
/** `pattern`: the folder is a path pattern like "[Journal]/YYYY" (custom source only); Daily / Periodic Notes folders are plain. */
export interface JournalLoc { folder: string; format: string; pattern?: boolean; /** template note path, from Daily / Periodic Notes */ template?: string }
export const PERIODIC_KINDS = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type PeriodicKind = typeof PERIODIC_KINDS[number];
export type Period = "daily" | PeriodicKind;
export const PERIOD_DEFAULT_FORMAT: Record<Period, string> = { daily: "YYYY-MM-DD", weekly: "YYYY-[W]ww", monthly: "YYYY-MM", quarterly: "[Q]Q", yearly: "YYYY" };
const DEFAULT_FORMAT = PERIOD_DEFAULT_FORMAT.daily;
/* eslint-disable @typescript-eslint/no-explicit-any */
const readJson = async (app: App, path: string): Promise<any> => {
  try { return JSON.parse(await app.vault.adapter.read(normalizePath(path))); } catch { return null; }
};
const cfg = (app: App, rel: string) => `${app.vault.configDir}/${rel}`;

async function coreDailyEnabled(app: App): Promise<boolean> {
  const live = (app as any).internalPlugins?.plugins?.["daily-notes"]?.enabled;
  if (typeof live === "boolean") return live;
  const j = await readJson(app, cfg(app, "core-plugins.json"));
  return Array.isArray(j) ? j.includes("daily-notes") : !!j?.["daily-notes"];
}
async function periodicConfig(app: App, p: Period): Promise<JournalLoc | null> {
  const live = (app as any).plugins?.enabledPlugins;
  const on = live instanceof Set ? live.has("periodic-notes") : ((await readJson(app, cfg(app, "community-plugins.json"))) ?? []).includes("periodic-notes");
  if (!on) return null;
  const d = (await readJson(app, cfg(app, "plugins/periodic-notes/data.json")))?.[p];
  if (!d || d.enabled === false) return null; // this kind of note is switched off in the plugin
  return { folder: String(d.folder ?? "").trim(), format: String(d.format || "").trim() || PERIOD_DEFAULT_FORMAT[p], template: String(d.template ?? "").trim() };
}
async function coreDailyConfig(app: App): Promise<JournalLoc | null> {
  if (!(await coreDailyEnabled(app))) return null;
  const j = await readJson(app, cfg(app, "daily-notes.json"));
  return { folder: String(j?.folder ?? "").trim(), format: String(j?.format || "").trim() || DEFAULT_FORMAT, template: String(j?.template ?? "").trim() };
}

/** Which note sources exist in this vault right now for a kind of note, with the folder / format each one prescribes. Only daily notes have a core plugin. */
export async function journalSources(app: App, p: Period = "daily"): Promise<{ daily: JournalLoc | null; periodic: JournalLoc | null }> {
  return { daily: p === "daily" ? await coreDailyConfig(app) : null, periodic: await periodicConfig(app, p) };
}
/** The source in effect: the chosen one if available, else the first available (Periodic Notes, Daily notes), else custom. */
export function pickJournalSource(avail: { daily: unknown; periodic: unknown }, wanted: string): JournalSource {
  const order: JournalSource[] = wanted === "custom" ? [] : wanted === "daily" ? ["daily", "periodic"] : ["periodic", "daily"];
  return order.find(k => avail[k as "daily" | "periodic"]) ?? "custom";
}
export async function journalLocation(app: App, s: SamayaSettings): Promise<JournalLoc & { source: JournalSource }> {
  const avail = await journalSources(app); const source = pickJournalSource(avail, s.journalSource);
  const loc = source === "custom" ? { folder: s.journalFolder.trim(), format: s.journalFormat.trim() || DEFAULT_FORMAT, pattern: true } : avail[source]!;
  return { ...loc, source };
}
/** Where weekly / monthly / quarterly / yearly notes go (null when that kind is switched off); daily notes as journalLocation. */
export async function periodLocation(app: App, s: SamayaSettings, p: Period): Promise<(JournalLoc & { source: JournalSource }) | null> {
  if (p === "daily") return journalLocation(app, s);
  const n = s.journalNotes[p]; if (!s.journalOn || !n.on) return null;
  const avail = await journalSources(app, p); const source = pickJournalSource(avail, n.source);
  const loc = source === "custom" ? { folder: n.folder.trim(), format: n.format.trim() || PERIOD_DEFAULT_FORMAT[p], pattern: true } : avail[source]!;
  return { ...loc, source };
}
/** Vault path of the note of a period containing `date` (null when that kind is switched off) and whether it exists yet. */
export async function periodNotePath(app: App, s: SamayaSettings, p: Period, date: string): Promise<{ path: string; file: TFile | null } | null> {
  const loc = await periodLocation(app, s, p); if (!loc) return null;
  const path = journalPathFor(loc, date); const f = app.vault.getAbstractFileByPath(path);
  return { path, file: f instanceof TFile ? f : null };
}
/** The item with the latest date that is not after `limit` (YYYY-MM-DD). Pure. */
export function latestOnOrBefore<T extends { date: string }>(items: T[], limit: string): T | null {
  return items.filter(i => i.date <= limit).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}
/** All existing notes of a kind, oldest first, found by parsing file names with the configured format. */
export async function listPeriodNotes(app: App, s: SamayaSettings, p: Period): Promise<Array<{ file: TFile; date: string }>> {
  const loc = await periodLocation(app, s, p); if (!loc) return [];
  const root = loc.pattern ? rootOf(loc.folder) : normalizePath(loc.folder || "/"); const prefix = root === "/" ? "" : root + "/";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moment = (window as any).moment; const items: Array<{ file: TFile; date: string }> = [];
  const hasYear = /[YyGg]/.test(loc.format.replace(/\[[^\]]*\]/g, ""));
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(prefix)) continue;
    const m = moment(f.basename, loc.format, true); if (!m.isValid()) continue;
    const yr = f.path.match(/(?:^|\/)((?:19|20)\d{2})(?:\/|-|$)/)?.[1]; if (yr && !hasYear) m.year(Number(yr));
    items.push({ file: f, date: m.format("YYYY-MM-DD") });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}
/** The most recent existing note of a kind up to today. */
export async function findLatestPeriodNote(app: App, s: SamayaSettings, p: Period): Promise<TFile | null> {
  return latestOnOrBefore(await listPeriodNotes(app, s, p), today())?.file ?? null;
}
/** The items just before and after `date` in a list sorted by date. Pure. */
export function neighbours<T extends { date: string }>(items: T[], date: string): { prev: T | null; next: T | null } {
  let prev: T | null = null, next: T | null = null;
  for (const i of items) { if (i.date < date) prev = i; else if (i.date > date && !next) next = i; }
  return { prev, next };
}
/** Which note of the journal a file is (kind and a date inside its period), or null. Matches by file name format inside the kind's folder, wherever in it the file sits. */
export async function identifyNote(app: App, s: SamayaSettings, file: TFile): Promise<{ p: Period; date: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moment = (window as any).moment;
  const yr = file.path.match(/(?:^|\/)((?:19|20)\d{2})(?:\/|-|$)/)?.[1]; // formats without a year (e.g. [Q]Q) take it from the path
  for (const p of ["daily", "weekly", "monthly", "quarterly", "yearly"] as Period[]) {
    const loc = await periodLocation(app, s, p); if (!loc) continue;
    const root = loc.pattern ? rootOf(loc.folder) : normalizePath(loc.folder || "/"); const prefix = root === "/" ? "" : root + "/";
    if (!file.path.startsWith(prefix)) continue;
    const m = moment(file.basename, loc.format, true); if (!m.isValid()) continue;
    if (yr && !/[YyGg]/.test(loc.format.replace(/\[[^\]]*\]/g, ""))) m.year(Number(yr));
    return { p, date: m.format("YYYY-MM-DD") };
  }
  return null;
}
/** The note of a period containing `date`, created (from the configured template) when missing. */
export async function openPeriodNote(app: App, s: SamayaSettings, p: Period, date: string): Promise<TFile | null> {
  const loc = await periodLocation(app, s, p); if (!loc) return null;
  const path = journalPathFor(loc, date); const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; if (dir) await ensureFolder(app, dir);
  const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  const tpl = loc.template ? renderTemplate(await loadTemplate(app, loc.template, ""), { title, date: new Date(date + "T12:00:00") }, momentFmt) : "";
  return app.vault.create(path, tpl);
}
export function journalPathFor(loc: JournalLoc, date: string): string {
  const d = new Date(date + "T12:00:00"); const name = momentFmt(d, loc.format);
  const folder = loc.pattern ? renderPath(loc.folder, d, momentFmt) : loc.folder;
  return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
}
/** Path of the daily note, from the chosen source (Daily notes, Periodic Notes or the custom folder). */
export async function journalPath(app: App, s: SamayaSettings, date: string): Promise<string> {
  return journalPathFor(await journalLocation(app, s), date);
}
export async function readJournalSection(app: App, s: SamayaSettings, date: string, h: Section): Promise<string[]> {
  const f = app.vault.getAbstractFileByPath(await journalPath(app, s, date));
  return f instanceof TFile ? readSection(await app.vault.read(f), h) : [];
}
/** Write a section into an existing note (the weekly note), keeping the order of `order`. */
export async function writeFileSection(app: App, f: TFile, heading: string, body: string, order: readonly string[]): Promise<void> {
  await app.vault.process(f, t => upsertSection(t, heading, body, order));
}
/** One day of the week plan, for the weekly note. */
export interface DayPlan { /** weekday name, e.g. "Monday" */ weekday: string; label: string; /** basename of the day's daily note: the weekday links to it */ note?: string; /** minutes of planned tasks */ planned: number; meetings: number; /** free minutes: work time - lunch - meetings */ free: number; tasks: JournalTask[]; events: Array<{ title: string; start: Date; end: Date; allDay: boolean; /** meeting note to link to */ note?: string }>; }
const fmtMin = (m: number) => fmtEstimate(m) || "0 min";
/** The weekday as a link to its daily note (plain text without one). */
const dayLink = (d: DayPlan, inTable = false) => (d.note ? `[[${d.note}${inTable ? "\\|" : "|"}${d.label}]]` : d.label); // inside a table the alias pipe is escaped
/** "██████░░░░ 60%": how much of the day's free time is planned. Pure. */
export function loadBar(planned: number, free: number): string {
  if (free <= 0) return planned > 0 ? "██████████ over" : "–";
  const pct = Math.round((planned / free) * 100); const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return `${"█".repeat(n)}${"░".repeat(10 - n)} ${pct}%`;
}
/** "" while there is room, else why the day is full. */
export function loadNote(planned: number, free: number): string {
  const l = loadLevel(planned, free); return l === "over" ? "over capacity" : l === "tight" ? `past the ${Math.round(BUFFER_SHARE * 100)}% buffer` : "";
}
/** The "Week plan" section: totals and a table with one row per day that links to the day's section. Pure. */
export function weekOverview(days: DayPlan[], noDay: number): string {
  const sum = (f: (d: DayPlan) => number) => days.reduce((a, d) => a + f(d), 0);
  const planned = sum(d => d.planned), meetings = sum(d => d.meetings), free = sum(d => d.free);
  const spare = sum(d => Math.max(0, d.free - d.planned)); const n = sum(d => d.tasks.length);
  const cell = (m: number) => (m > 0 ? fmtMin(m) : "–");
  const rows = days.map(d => `| ${dayLink(d, true)} | ${cell(d.planned)}${d.tasks.length ? ` (${d.tasks.length})` : ""} | ${cell(d.meetings)} | ${cell(Math.max(0, d.free - d.planned))} | ${loadBar(d.planned, d.free)} |`);
  return [
    `**${fmtMin(planned)}** of tasks · **${fmtMin(meetings)}** of meetings · **${fmtMin(spare)}** unplanned`,
    `${n + noDay} ${n + noDay === 1 ? "task" : "tasks"}, ${n} scheduled${noDay ? `, ${noDay} still without a day` : ""}.`,
    "",
    "| Day | Tasks | Meetings | Unplanned | Load |", "| --- | --- | --- | --- | --- |", ...rows,
    `| **Week** | **${cell(planned)}**${n ? ` (${n})` : ""} | **${cell(meetings)}** | **${cell(spare)}** | ${loadBar(planned, free)} |`,
  ].join("\n");
}
/** The "Meetings" section: a bullet per weekday that has meetings, the meetings nested below it. Pure. */
export function weekMeetings(days: DayPlan[]): string {
  const withMeetings = days.filter(d => d.events.length);
  if (!withMeetings.length) return "- None";
  return withMeetings.map(d => `- **${d.weekday}**\n` + meetingLines(d.events).split("\n").map(l => "    " + l).join("\n")).join("\n");
}
export async function writeSection(app: App, s: SamayaSettings, date: string, heading: Section, body: string): Promise<void> {
  const path = await journalPath(app, s, date);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) await ensureFolder(app, dir);
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) await app.vault.process(f, t => upsertSection(t, heading, body));
  else await app.vault.create(path, upsertSection("", heading, body));
}

/** Planned time of day of a task: its segments, or start-end from `start` + estimate ("" when unscheduled). */
export function plannedTime(t: Pick<Task, "start" | "estimate" | "segments">): string {
  if (t.segments.length) return fmtSegments(t.segments).join(", ");
  if (!t.start) return "";
  const [h, m] = t.start.split(":").map(Number); const s = h * 60 + m;
  return t.estimate > 0 ? `${minToHm(s)}-${minToHm(s + t.estimate)}` : minToHm(s);
}

/** Scheduled tasks by start time, unscheduled ones (no start) after them in their original order. Stable, pure. */
export function sortByStart<T extends { start: string }>(tasks: T[]): T[] {
  const key = (t: T) => (t.start ? hmToMin(t.start) : Infinity);
  return tasks.map((t, i) => ({ t, i })).sort((a, b) => (key(a.t) - key(b.t)) || (a.i - b.i)).map(x => x.t);
}

export async function toJournalTasks(app: App, tasks: Task[], useActual = false, withTime = false): Promise<JournalTask[]> {
  return Promise.all(tasks.map(async t => ({
    title: t.title, minutes: (useActual && t.actual) || t.estimate, time: withTime ? plannedTime(t) : undefined,
    subtasks: (await readSubtasks(app, t.file)).map(s => s.text),
  })));
}

/** Set / remove (null) frontmatter properties of the daily note, creating it if needed. Arrays allowed. */
export async function setJournalProps(app: App, s: SamayaSettings, date: string, patch: Record<string, string | number | boolean | string[] | null>): Promise<void> {
  const path = await journalPath(app, s, date);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) await ensureFolder(app, dir);
  let f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) f = await app.vault.create(path, "");
  await app.fileManager.processFrontMatter(f as TFile, fm => {
    for (const [k, v] of Object.entries(patch)) { if (v === null || (Array.isArray(v) && !v.length)) delete fm[k]; else fm[k] = v; }
  });
}
/** Human title of a note for the navigation bar, plus the label of the "jump to now" button. */
export const PERIOD_UI: Record<Period, { title: string; now: string; noun: string }> = {
  daily: { title: "dddd, D MMMM YYYY", now: "Today", noun: "day" },
  weekly: { title: "[Week] W, GGGG", now: "This week", noun: "week" },
  monthly: { title: "MMMM YYYY", now: "This month", noun: "month" },
  quarterly: { title: "[Q]Q YYYY", now: "This quarter", noun: "quarter" },
  yearly: { title: "YYYY", now: "This year", noun: "year" },
};
