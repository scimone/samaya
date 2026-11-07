import { App, TFile, normalizePath } from "obsidian";
import type { IcsEvent } from "./ics";
import type { SamayaSettings } from "./settings";
import { ensureFolder, loadTemplate, momentFmt, patchTask } from "./model";
import { DEFAULT_MEETING_TEMPLATE, monthFolder, renderTemplate } from "./taskbody";
import { minToHm, slugify, ymd } from "./util";

/** Find or create the note for a calendar meeting: `Meetings/YYYY/MM/yyyy-mm-dd_<title-slug>.md`. Never overwrites existing notes. */
export async function ensureMeetingNote(app: App, s: SamayaSettings, ev: IcsEvent): Promise<TFile> {
  const root = normalizePath(s.meetingsFolder); const folder = monthFolder(root, ev.start);
  const date = ymd(ev.start); const start = minToHm(ev.start.getHours() * 60 + ev.start.getMinutes());
  const end = minToHm(ev.end.getHours() * 60 + ev.end.getMinutes());
  const base = `${date}_${slugify(ev.title)}`;
  // same title twice on one day: disambiguate by start time. Flat legacy location is still recognised.
  const names = [base, `${base}-${start.replace(":", "")}`];
  for (const name of names) {
    for (const dir of [folder, root]) {
      const hit = app.vault.getAbstractFileByPath(`${dir}/${name}.md`);
      if (!(hit instanceof TFile)) continue;
      const fm = app.metadataCache.getFileCache(hit)?.frontmatter;
      if (!fm || String(fm.start) === start) return hit; // not indexed yet: assume ours
    }
    if (!app.vault.getAbstractFileByPath(`${folder}/${name}.md`)) {
      await ensureFolder(app, folder);
      const tpl = renderTemplate(await loadTemplate(app, s.meetingTemplate, DEFAULT_MEETING_TEMPLATE), { title: ev.title, date: ev.start, start, end }, momentFmt);
      const file = await app.vault.create(`${folder}/${name}.md`, tpl);
      await patchTask(app, file, { type: "meeting", title: ev.title, date, start, end });
      return file;
    }
  }
  return app.vault.getAbstractFileByPath(`${folder}/${names[1]}.md`) as TFile;
}
