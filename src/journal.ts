// Daily note ("Journal") sections written by the planning and shutdown rituals.
import { App, TFile, normalizePath } from "obsidian";
import type { SamayaSettings } from "./settings";
import { renderPath } from "./taskbody";
import { Task, ensureFolder, momentFmt, readSubtasks } from "./model";

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
export interface JournalLoc { folder: string; format: string; pattern?: boolean }
const DEFAULT_FORMAT = "YYYY-MM-DD";
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
async function periodicDailyConfig(app: App): Promise<JournalLoc | null> {
  const live = (app as any).plugins?.enabledPlugins;
  const on = live instanceof Set ? live.has("periodic-notes") : ((await readJson(app, cfg(app, "community-plugins.json"))) ?? []).includes("periodic-notes");
  if (!on) return null;
  const d = (await readJson(app, cfg(app, "plugins/periodic-notes/data.json")))?.daily;
  if (!d || d.enabled === false) return null; // the plugin's daily notes are switched off
  return { folder: String(d.folder ?? "").trim(), format: String(d.format || "").trim() || DEFAULT_FORMAT };
}
async function coreDailyConfig(app: App): Promise<JournalLoc | null> {
  if (!(await coreDailyEnabled(app))) return null;
  const j = await readJson(app, cfg(app, "daily-notes.json"));
  return { folder: String(j?.folder ?? "").trim(), format: String(j?.format || "").trim() || DEFAULT_FORMAT };
}

/** Which daily note sources exist in this vault right now, with the folder / format each one prescribes. */
export async function journalSources(app: App): Promise<{ daily: JournalLoc | null; periodic: JournalLoc | null }> {
  return { daily: await coreDailyConfig(app), periodic: await periodicDailyConfig(app) };
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
