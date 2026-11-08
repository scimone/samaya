// Pure helpers for task / meeting note bodies and templates (no Obsidian imports, unit-tested).
import { safeFileName, slugify } from "./util";
export const DEFAULT_TASK_TEMPLATE = "## Subtasks\n\n## Notes\n";
export const DEFAULT_MEETING_TEMPLATE = "# {{title}}\n\n## Meeting Summary\n\n";

const heading = (name: string) => new RegExp(`^##\\s+${name}\\s*$`, "i");
const ANY_HEADING = /^#{1,6}\s/;

/** Make sure the body has a "## Subtasks" heading (before "## Notes" if there is one, else at the end). */
export function ensureSubtasksHeading(text: string): string {
  const lines = text.split("\n");
  if (lines.some(l => heading("Subtasks").test(l))) return text;
  const ni = lines.findIndex(l => heading("Notes").test(l));
  if (ni >= 0) { lines.splice(ni, 0, "## Subtasks", "", ""); return lines.join("\n"); }
  const base = text.replace(/\s+$/, "");
  return (base ? base + "\n\n" : "") + "## Subtasks\n\n";
}

/** Append `- [ ] item` to the end of the "## Subtasks" section. */
export function insertSubtask(text: string, item: string): string {
  const lines = ensureSubtasksHeading(text).split("\n");
  const hi = lines.findIndex(l => heading("Subtasks").test(l));
  let end = hi + 1; while (end < lines.length && !ANY_HEADING.test(lines[end])) end++;
  let at = end; while (at > hi + 1 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, `- [ ] ${item}`);
  if (at + 1 < lines.length && ANY_HEADING.test(lines[at + 1])) lines.splice(at + 1, 0, "");
  return lines.join("\n");
}

export interface TplCtx { title: string; date: Date; start?: string; end?: string; }
/** Supports {{title}}, {{date}}, {{date:FORMAT}}, {{time}}, {{time:FORMAT}}, {{start}}, {{end}} (core Templates syntax). */
export function renderTemplate(tpl: string, ctx: TplCtx, fmt: (d: Date, f: string) => string): string {
  return tpl.replace(/\{\{\s*(title|date|time|start|end)\s*(?::([^}]*))?\}\}/g, (_m, k: string, f?: string) => {
    switch (k) {
      case "title": return ctx.title;
      case "date": return fmt(ctx.date, f?.trim() || "YYYY-MM-DD");
      case "time": return fmt(new Date(), f?.trim() || "HH:mm");
      case "start": return ctx.start ?? "";
      default: return ctx.end ?? "";
    }
  });
}

type Fmt = (d: Date, f: string) => string;
/** Render a path pattern like "[Meetings]/YYYY/YYYY-MM" (moment format) for a date. Slashes separate folders. */
export function renderPath(pattern: string, d: Date, fmt: Fmt): string {
  return pattern.split("/").map(seg => fmt(d, seg).trim()).filter(Boolean).join("/");
}
/** The leading folders of a pattern that do not depend on the date, e.g. "[Meetings]/YYYY/YYYY-MM" -> "Meetings". */
export function pathRoot(pattern: string, fmt: Fmt): string {
  const a = new Date(2024, 1, 3, 8, 9), b = new Date(2027, 10, 28, 21, 47);
  const out: string[] = [];
  for (const seg of pattern.split("/")) {
    const x = fmt(a, seg).trim(), y = fmt(b, seg).trim();
    if (seg.includes("{{") || x !== y) break; // ticket variables differ per note, so they are never part of the root
    if (x) out.push(x);
  }
  return out.join("/");
}

// ---------- ticket notes (Jira / GitLab) ----------
export interface TicketVars { id: string; title: string; type: string; status: string; assignedTo: string; url: string; description: string; source: string; }
export const DEFAULT_TICKET_TEMPLATE = "# {{TASK_TITLE}}\n\n[Open in {{TASK_SOURCE}}]({{TASK_URL}})\n";
export const DEFAULT_TICKET_FILENAME = "{{TASK_ID}}_{{TASK_TITLE_SLUG}}";
export const TICKET_VARIABLES = "TASK_ID, TASK_TITLE, TASK_TYPE, TASK_STATUS, TASK_ASSIGNEDTO, TASK_URL, TASK_DESCRIPTION";

function ticketVarMap(v: TicketVars): Record<string, string> {
  return { TASK_ID: v.id, TASK_TITLE: v.title, TASK_TITLE_SLUG: slugify(v.title, "untitled"), TASK_TYPE: v.type, TASK_STATUS: v.status,
    TASK_ASSIGNEDTO: v.assignedTo, TASK_URL: v.url, TASK_DESCRIPTION: v.description, TASK_SOURCE: v.source };
}
/** Replace {{TASK_*}} variables (unknown names are left untouched). `esc` post-processes each value. */
export function fillTicketVars(tpl: string, v: TicketVars, esc: (x: string) => string = x => x): string {
  const m = ticketVarMap(v);
  return tpl.replace(/\{\{\s*(TASK_[A-Z_]+)\s*\}\}/g, (all, k: string) => (k in m ? esc(m[k]) : all));
}
/** Note body from a user template (or the built-in one). */
export function renderTicketNote(tpl: string, v: TicketVars): string { return fillTicketVars(tpl || DEFAULT_TICKET_TEMPLATE, v); }
/** File name (without ".md") from the file name template. */
export function renderTicketFileName(tpl: string, v: TicketVars): string { return safeFileName(fillTicketVars(tpl.trim() || DEFAULT_TICKET_FILENAME, v)); }
/** Folder pattern with {{TASK_*}} variables, e.g. "[Tickets]/[Jira]/{{TASK_STATUS}}". Values are inserted as moment literals. */
export function renderTicketPath(pattern: string, v: TicketVars, d: Date, fmt: Fmt): string {
  const part = (x: string) => `[${x.trim() ? safeFileName(x) : "None"}]`;
  return renderPath(fillTicketVars(pattern, v, part), d, fmt);
}
