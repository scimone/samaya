// Pure helpers for task / meeting note bodies and templates (no Obsidian imports, unit-tested).
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

export function monthFolder(root: string, d: Date): string {
  return `${root}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}
