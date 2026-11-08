import { App, TFile, normalizePath } from "obsidian";
import type { IcsEvent } from "./ics";
import type { SamayaSettings } from "./settings";
import { ensureFolder, folderFor, rootOf, loadTemplate, momentFmt, patchTask } from "./model";
import { DEFAULT_MEETING_TEMPLATE, renderTemplate } from "./taskbody";
import { addDays, minToHm, parseYmd, slugify, ymd } from "./util";
import type SamayaPlugin from "./main";

let lock: Promise<unknown> = Promise.resolve();
/** Find or create the note for a calendar meeting: `<meetings path>/yyyy-mm-dd_<title-slug>.md`. Never overwrites existing notes;
 *  when the calendar moved the (only) meeting of that name on that day, the note's start/end properties follow. `dayEvents`
 *  (all events around ev) is used to tell a moved meeting from two same-titled meetings. Calls are serialised. */
export function ensureMeetingNote(app: App, s: SamayaSettings, ev: IcsEvent, dayEvents?: IcsEvent[]): Promise<TFile> {
  const run = lock.then(() => ensureNote(app, s, ev, dayEvents));
  lock = run.catch(() => undefined);
  return run;
}

async function ensureNote(app: App, s: SamayaSettings, ev: IcsEvent, dayEvents?: IcsEvent[]): Promise<TFile> {
  if (ev.notePath) { const f = app.vault.getAbstractFileByPath(ev.notePath); if (f instanceof TFile) return f; } // event already is a note
  const root = rootOf(s.meetingsPath); const folder = folderFor(s.meetingsPath, ev.start);
  const date = ymd(ev.start); const start = minToHm(ev.start.getHours() * 60 + ev.start.getMinutes());
  const end = minToHm(ev.end.getHours() * 60 + ev.end.getMinutes());
  const base = `${date}_${slugify(ev.title)}`;
  // same title twice on one day: disambiguate by start time. Flat legacy location is still recognised.
  const names = [base, `${base}-${start.replace(":", "")}`];
  const unique = (dayEvents ?? [ev]).filter(e => !e.allDay && ymd(e.start) === date && slugify(e.title) === slugify(ev.title)).length <= 1;
  for (const name of names) {
    for (const dir of [folder, root]) {
      const hit = app.vault.getAbstractFileByPath(`${dir}/${name}.md`);
      if (!(hit instanceof TFile)) continue;
      const fm = app.metadataCache.getFileCache(hit)?.frontmatter;
      if (!fm) return hit; // not indexed yet: assume ours
      if (String(fm.start) === start) {
        if (unique && fm.end != null && String(fm.end) !== end) await patchTask(app, hit, { end });
        return hit;
      }
      if (unique && name === base) { await patchTask(app, hit, { start, end }); return hit; } // meeting moved within the day
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

/** Notes are generated for today and this many days ahead. */
export const MEETING_SYNC_AHEAD_DAYS = 14;

/** Fetch the ICS feeds afresh and create/update the notes of all timed events from today through the next 14 days. Returns the number of new notes. */
export async function syncMeetingNotes(plugin: SamayaPlugin): Promise<number> {
  const s = plugin.settings;
  if (!s.calendarOn || s.calendarSource === "notes" || !s.icsUrls.length) return 0;
  plugin.ics.clear();
  const from = parseYmd(ymd(new Date())); const to = parseYmd(addDays(ymd(new Date()), MEETING_SYNC_AHEAD_DAYS + 1));
  const events = (await plugin.ics.eventsBetween(from, to)).filter(e => !e.allDay);
  const known = new Set(plugin.app.vault.getMarkdownFiles().map(f => f.path));
  let created = 0;
  for (const ev of events) {
    try { const f = await ensureMeetingNote(plugin.app, s, ev, events); if (!known.has(f.path)) { known.add(f.path); created++; } }
    catch (e) { console.warn("Samaya: meeting note failed", e); }
  }
  return created;
}
