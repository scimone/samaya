// Daily note ("Journal") sections written by the planning and shutdown rituals.
import { App, TFile, normalizePath } from "obsidian";
import type { SamayaSettings } from "./settings";
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

/** Path of the daily note, honouring Settings > Daily notes (folder + date format); falls back to our own settings. */
export async function journalPath(app: App, s: SamayaSettings, date: string): Promise<string> {
  let folder = s.journalFolder, format = "YYYY-MM-DD";
  try {
    const raw = await app.vault.adapter.read(normalizePath(`${app.vault.configDir}/daily-notes.json`));
    const j = JSON.parse(raw) as { folder?: string; format?: string };
    if (typeof j.folder === "string") folder = j.folder.trim();
    if (j.format) format = j.format;
  } catch { /* plugin not configured: defaults */ }
  const name = momentFmt(new Date(date + "T12:00:00"), format);
  return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
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
