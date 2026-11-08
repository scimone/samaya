// Daily note ("Journal") sections written by the planning and shutdown rituals.
import { App, TFile, normalizePath } from "obsidian";
import type { SamayaSettings } from "./settings";
import { renderPath, renderTemplate } from "./taskbody";
import { Task, ensureFolder, loadTemplate, momentFmt, readSubtasks, rootOf } from "./model";
import { today } from "./util";

export type JournalPart = "journalPlanned" | "journalObstacles" | "journalFinished" | "journalTomorrow" | "journalWorkTimes" | "journalBreaks" | "journalTracked";
/** Whether the journal module is on and the given part of it is enabled. */
export const journalWants = (s: SamayaSettings, part: JournalPart): boolean => s.journalOn && s[part];

export const SECTIONS = ["Planned today", "Obstacles in my way", "Finished today", "Planned for tomorrow"] as const;
export type Section = typeof SECTIONS[number];

export function fmtEstimate(min: number): string {
  if (!min || min <= 0) return "";
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60; return `${Number.isInteger(h) ? h : +h.toFixed(2)} hr`;
}

export interface JournalTask { title: string; minutes: number; subtasks: string[]; }

export function taskLines(items: JournalTask[]): string {
  if (!items.length) return "- None";
  return items.map(t => {
    const est = fmtEstimate(t.minutes);
    return [`- [[${t.title}]]${est ? ` • *${est}*` : ""}`, ...t.subtasks.map(s => `    - ${s}`)].join("\n");
  }).join("\n");
}
export function bulletLines(lines: string[]): string {
  const l = lines.map(x => x.trim().replace(/^[-*]\s+/, "")).filter(Boolean);
  return l.length ? l.map(x => `- ${x}`).join("\n") : "- None";
}

/** Replace the body of `## heading` (or insert it in canonical order). Pure. */
export function upsertSection(text: string, heading: Section, body: string): string {
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
  const myPos = SECTIONS.indexOf(heading);
  let insertAt = -1;
  for (let k = myPos + 1; k < SECTIONS.length && insertAt < 0; k++) insertAt = find(SECTIONS[k]);
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
/** The most recent existing note of a kind up to today, found by parsing file names with the configured format. */
export async function findLatestPeriodNote(app: App, s: SamayaSettings, p: Period): Promise<TFile | null> {
  const loc = await periodLocation(app, s, p); if (!loc) return null;
  const root = loc.pattern ? rootOf(loc.folder) : normalizePath(loc.folder || "/"); const prefix = root === "/" ? "" : root + "/";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moment = (window as any).moment; const items: Array<{ file: TFile; date: string }> = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(prefix)) continue;
    const m = moment(f.basename, loc.format, true); if (m.isValid()) items.push({ file: f, date: m.format("YYYY-MM-DD") });
  }
  return latestOnOrBefore(items, today())?.file ?? null;
}
/** Which note of the journal a file is (kind and a date inside its period), or null. */
export async function identifyNote(app: App, s: SamayaSettings, file: TFile): Promise<{ p: Period; date: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moment = (window as any).moment;
  const yr = file.path.match(/(?:^|\/)((?:19|20)\d{2})(?:\/|-|$)/)?.[1]; // formats without a year (e.g. [Q]Q) take it from the path
  for (const p of ["daily", "weekly", "monthly", "quarterly", "yearly"] as Period[]) {
    const loc = await periodLocation(app, s, p); if (!loc) continue;
    const m = moment(file.basename, loc.format, true); if (!m.isValid()) continue;
    for (const cand of yr && m.year() !== Number(yr) ? [m.format("YYYY-MM-DD"), m.clone().year(Number(yr)).format("YYYY-MM-DD")] : [m.format("YYYY-MM-DD")]) {
      if (journalPathFor(loc, cand) === file.path) return { p, date: cand };
    }
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
export async function writeSection(app: App, s: SamayaSettings, date: string, heading: Section, body: string): Promise<void> {
  const path = await journalPath(app, s, date);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) await ensureFolder(app, dir);
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) await app.vault.process(f, t => upsertSection(t, heading, body));
  else await app.vault.create(path, upsertSection("", heading, body));
}

export async function toJournalTasks(app: App, tasks: Task[], useActual = false): Promise<JournalTask[]> {
  return Promise.all(tasks.map(async t => ({
    title: t.title, minutes: (useActual && t.actual) || t.estimate,
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
