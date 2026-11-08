import { AbstractInputSuggest, App, PluginSettingTab, Setting } from "obsidian";
import type SamayaPlugin from "./main";
import { ticketFolderFor, folderFor } from "./model";
import { MEETING_SYNC_DAYS, generateMeetingNotes } from "./meetings";
import { TICKET_VARIABLES, renderTicketFileName, TicketVars } from "./taskbody";
import { JournalLoc, JournalSource, journalLocation, journalPathFor, journalSources } from "./journal";
import { DEFAULT_EVENT_PATTERN, PATTERN_HELP, compilePattern } from "./eventnotes";

export interface SamayaSettings {
  tasksPath: string; ticketsPath: string; meetingsPath: string; journalSource: "auto" | JournalSource; journalFolder: string; journalFormat: string; plannerFile: string;
  taskTemplate: string; meetingTemplate: string; ticketTemplate: string; ticketFileName: string;
  calendarSource: "ics" | "notes"; eventNotesFolder: string; eventNotePattern: string;
  icsUrls: string[]; icsRefreshMinutes: number;
  dayStartHour: number; dayEndHour: number; slotMinutes: number;
  defaultEstimate: number; capacityHours: number; shutdownTime: string; openOnStartup: boolean;
  jiraFlavor: "cloud" | "server"; jiraUrl: string; jiraEmail: string; jiraToken: string; jiraJql: string;
  gitlabUrl: string; gitlabToken: string; gitlabScope: "assigned_to_me" | "created_by_me" | "all";
  syncOnStartup: boolean;
  lunchStart: string; lunchEnd: string; weeklyHours: number; workDays: number; autoLunch: boolean;
  /** optional modules; off by default for new installs */
  calendarOn: boolean; jiraOn: boolean; gitlabOn: boolean;
}
export const DEFAULT_SETTINGS: SamayaSettings = {
  tasksPath: "[Tasks]/YYYY/MM", ticketsPath: "[Tickets]/{{TICKET_SOURCE}}/{{TICKET_STATUS}}", meetingsPath: "[Meetings]/YYYY/MM", journalSource: "auto", journalFolder: "[Journal]", journalFormat: "YYYY-MM-DD", plannerFile: "Planner/Planner.base", taskTemplate: "", meetingTemplate: "", ticketTemplate: "", ticketFileName: "{{TICKET_ID}}_{{TICKET_TITLE_SLUG}}",
  calendarSource: "ics", eventNotesFolder: "Meetings", eventNotePattern: "{{date}}_{{title}}",
  icsUrls: [], icsRefreshMinutes: 15,
  dayStartHour: 7, dayEndHour: 20, slotMinutes: 15, defaultEstimate: 30, capacityHours: 6, shutdownTime: "17:30", openOnStartup: false,
  jiraFlavor: "cloud", jiraUrl: "", jiraEmail: "", jiraToken: "",
  jiraJql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
  gitlabUrl: "https://gitlab.com", gitlabToken: "", gitlabScope: "assigned_to_me", syncOnStartup: false,
  lunchStart: "12:00", lunchEnd: "13:00", weeklyHours: 40, workDays: 5, autoLunch: true,
  calendarOn: false, jiraOn: false, gitlabOn: false,
};

/** Settings saved by older versions used plain folders; turn them into equivalent path patterns. */
export function migrateSettings(saved: Record<string, unknown>): Partial<SamayaSettings> {
  const o = { ...saved } as Record<string, unknown>;
  const lit = (v: unknown) => `[${String(v).replace(/[[\]]/g, "")}]`;
  if (o.tasksFolder != null && o.tasksPath == null) o.tasksPath = lit(o.tasksFolder) + "/YYYY/MM";
  if (o.ticketsFolder != null && o.ticketsPath == null) o.ticketsPath = lit(o.ticketsFolder);
  if (o.meetingsFolder != null && o.meetingsPath == null) o.meetingsPath = lit(o.meetingsFolder) + "/YYYY/MM";
  // optional modules were implicit before: keep the ones that were already set up
  if (o.calendarOn == null) o.calendarOn = (o.calendarSource === "notes" && !!o.eventNotesFolder) || (Array.isArray(o.icsUrls) && o.icsUrls.length > 0);
  if (o.jiraOn == null) o.jiraOn = !!(o.jiraUrl && o.jiraToken);
  if (o.gitlabOn == null) o.gitlabOn = !!o.gitlabToken;
  // ticket variables were called TASK_* before
  for (const k of ["ticketsPath", "ticketFileName"]) if (typeof o[k] === "string") o[k] = (o[k] as string).replace(/\bTASK_/g, "TICKET_");
  // the daily note folder is a path pattern now: a plain name becomes a literal
  if (typeof o.journalFolder === "string" && o.journalFolder.trim() && !o.journalFolder.includes("[")) o.journalFolder = `[${o.journalFolder.trim().replace(/[[\]]/g, "")}]`;
  delete o.tasksFolder; delete o.ticketsFolder; delete o.meetingsFolder;
  return o as Partial<SamayaSettings>;
}

const SAMPLE_TICKET: TicketVars = { id: "OPS-12", title: "Fix the deploy pipeline", type: "Bug", status: "In Progress", assignedTo: "Ada", url: "", description: "", source: "Jira", project: "OPS" };
const HM = /^\d{1,2}:\d{2}$/;
const vars = (names: string) => names.split(", ").map(v => `{{${v}}}`).join(" ");

/** Autocomplete for a text input: pick from a list of vault paths. */
class PathSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private el: HTMLInputElement, private list: () => string[]) { super(app, el); }
  getSuggestions(q: string) { const l = q.toLowerCase(); return this.list().filter(p => p.toLowerCase().includes(l)).slice(0, 50); }
  renderSuggestion(v: string, el: HTMLElement) { el.setText(v); }
  selectSuggestion(v: string) { this.el.value = v; this.el.dispatchEvent(new Event("input")); this.close(); }
}

type Pill = [text: string, kind: "ok" | "warn" | "off"];
interface CardOpts { /** folds away unless true, without a switch of its own */ activeWhen?: () => boolean; enabled?: { get: () => boolean; set: (v: boolean) => void | Promise<void> }; status?: () => Pill }

export class SamayaSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SamayaPlugin) { super(app, plugin); }

  /** Where daily notes live: offer only the sources that are installed and enabled right now. */
  private async renderDailyNotes(box: HTMLElement, changed: () => Promise<void>) {
    const s = this.plugin.settings;
    const draw = async () => {
      const avail = await journalSources(this.app); const loc = await journalLocation(this.app, s);
      if (!box.isConnected) return; box.empty();
      const names: Record<JournalSource, string> = { daily: "Daily notes (core plugin)", periodic: "Periodic Notes (community plugin)", custom: "Custom folder" };
      const options = (["periodic", "daily"] as const).filter(k => avail[k]).map(k => k as JournalSource).concat("custom");
      if (options.length > 1) {
        new Setting(box).setName("Daily note location").setDesc("Where the planner reads and writes your daily notes.")
          .addDropdown(d => { for (const k of options) d.addOption(k, names[k]); d.setValue(loc.source).onChange(async v => { s.journalSource = v as JournalSource; await changed(); void draw(); }); });
      }
      // folder + file name form one path: grouped by an accent rule and closed by a shared preview
      const group = box.createDiv("samaya-pathgroup");
      const result = group.createDiv("samaya-pathresult");
      const show = (l: JournalLoc) => {
        const p = journalPathFor(l, new Date().toLocaleDateString("sv")); const i = p.lastIndexOf("/");
        result.empty(); result.createSpan({ cls: "samaya-pathresult-label", text: "Today's note" });
        const code = result.createEl("code");
        if (i >= 0) code.createSpan({ cls: "samaya-pathresult-dir", text: p.slice(0, i + 1) });
        code.createSpan({ cls: "samaya-pathresult-file", text: p.slice(i + 1) });
      };
      const rows = (folderSt: Setting, fileSt: Setting) => { group.insertBefore(folderSt.settingEl, result); group.insertBefore(fileSt.settingEl, result); };
      if (loc.source === "custom") {
        const cur = (): JournalLoc => ({ folder: s.journalFolder.trim(), format: s.journalFormat.trim() || "YYYY-MM-DD", pattern: true });
        const folderSt = new Setting(group).setName("Folder");
        folderSt.descEl.appendText("A folder pattern. Date parts use moment.js format; put literal text in [brackets], e.g. [Journal]/YYYY. ");
        folderSt.descEl.createEl("a", { text: "Syntax reference", href: "https://momentjs.com/docs/#/displaying/format" });
        if (options.length === 1) folderSt.descEl.createDiv({ text: "Enable the Daily notes core plugin or Periodic Notes and you can use their settings here instead." });
        folderSt.addText(t => t.setValue(s.journalFolder).setPlaceholder("[Journal]/YYYY").onChange(async v => { s.journalFolder = v.trim(); await changed(); show(cur()); }));
        const fileSt = new Setting(group).setName("File name").setDesc("moment.js format of the note's name, without “.md”.");
        fileSt.addText(t => t.setValue(s.journalFormat).setPlaceholder("YYYY-MM-DD").onChange(async v => { s.journalFormat = v.trim() || "YYYY-MM-DD"; await changed(); show(cur()); }));
        rows(folderSt, fileSt); show(cur());
      } else {
        const where = loc.source === "daily" ? "Settings › Daily notes" : "Settings › Periodic Notes";
        const ro = (name: string, value: string, desc = "") => new Setting(group).setName(name).setDesc(desc).addText(t => { t.setValue(value); t.setDisabled(true); });
        const folderSt = ro("Folder", loc.folder || "(vault root)", `Taken from ${where}. Change it there.`);
        const fileSt = ro("File name", loc.format);
        rows(folderSt, fileSt); show(loc);
      }
    };
    await draw();
  }

  display(): void {
    const { containerEl: c } = this; c.empty(); c.addClass("samaya-settings");
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveSettings(); };
    const refreshers: Array<() => void> = []; // status pills etc., re-run after any change
    const changed = async () => { await save(); refreshers.forEach(f => f()); };

    // ---- building blocks
    const label = (el: HTMLElement, text: string) => el.createDiv({ cls: "samaya-group-label", text });
    const note = (el: HTMLElement, text: string, cls = "") => el.createDiv({ cls: "samaya-note " + cls, text });

    /** One module: a header (with an on/off switch when optional) and a body that folds away while it is off. */
    const card = (title: string, desc: string, opts: CardOpts = {}) => {
      const el = c.createDiv("samaya-mod");
      const head = new Setting(el).setName(title).setDesc(desc);
      head.settingEl.addClass("samaya-mod-head");
      const pill = opts.status ? head.nameEl.createSpan("samaya-pill") : null;
      const inner = el.createDiv("samaya-mod-body").createDiv("samaya-mod-inner");
      const sync = () => {
        const on = opts.enabled ? opts.enabled.get() : opts.activeWhen ? opts.activeWhen() : true;
        el.toggleClass("is-off", !on); inner.parentElement?.toggleAttribute("inert", !on);
        if (pill && opts.status) { const [t, k] = on ? opts.status() : ["Off", "off" as const]; pill.setText(t); pill.className = "samaya-pill is-" + k; }
      };
      if (opts.enabled) head.addToggle(t => { t.setValue(opts.enabled!.get()).setTooltip("Enable " + title).onChange(async v => { await opts.enabled!.set(v); await changed(); }); });
      refreshers.push(sync); sync();
      return inner;
    };

    const text = (el: HTMLElement, name: string, desc: string, get: () => string, set: (v: string) => void, o: { secret?: boolean; placeholder?: string; time?: boolean; suggest?: () => string[]; after?: () => void } = {}) => {
      const st = new Setting(el).setName(name).setDesc(desc);
      st.addText(t => {
        t.setValue(get()).setPlaceholder(o.placeholder ?? "");
        if (o.time) t.inputEl.type = "time";
        t.onChange(async v => {
          v = v.trim();
          if (o.time && !HM.test(v)) { t.inputEl.addClass("is-invalid"); return; }
          t.inputEl.removeClass("is-invalid"); set(v); await changed(); o.after?.();
        });
        if (o.secret) {
          t.inputEl.type = "password"; t.inputEl.autocomplete = "off";
          st.addExtraButton(b => b.setIcon("eye").setTooltip("Show / hide").onClick(() => {
            const show = t.inputEl.type === "password"; t.inputEl.type = show ? "text" : "password"; b.setIcon(show ? "eye-off" : "eye");
          }));
        }
        if (o.suggest) new PathSuggest(this.app, t.inputEl, o.suggest);
      });
      return st;
    };

    const num = (el: HTMLElement, name: string, desc: string, get: () => number, set: (v: number) => void, o: { min?: number; max?: number; step?: number; int?: boolean } = {}) =>
      new Setting(el).setName(name).setDesc(desc).addText(t => {
        t.inputEl.type = "number"; t.inputEl.addClass("samaya-num");
        if (o.min != null) t.inputEl.min = String(o.min); if (o.max != null) t.inputEl.max = String(o.max); t.inputEl.step = String(o.step ?? (o.int ? 1 : "any"));
        t.setValue(String(get())).onChange(async v => {
          const n = Number(v);
          const bad = !!(v.trim() === "" || isNaN(n) || (o.min != null && n < o.min) || (o.max != null && n > o.max) || (o.int && !Number.isInteger(n)));
          t.inputEl.toggleClass("is-invalid", bad); if (bad) return;
          set(n); await changed();
        });
      });

    /** Two linked inputs on one row ("from – to"); a pair is only saved when both are valid and in order. */
    const range = (el: HTMLElement, name: string, desc: string, kind: "time" | "hour", from: [() => string | number, (v: never) => void], to: [() => string | number, (v: never) => void]) => {
      const st = new Setting(el).setName(name).setDesc(desc); st.settingEl.addClass("samaya-range");
      const inputs: HTMLInputElement[] = [];
      const val = (i: HTMLInputElement): number | null => {
        if (kind === "time") { if (!HM.test(i.value.trim())) return null; const [h, m] = i.value.split(":").map(Number); return h * 60 + m; }
        const n = Number(i.value); return i.value.trim() === "" || !Number.isInteger(n) ? null : n;
      };
      const check = async () => {
        const [a, b] = [val(inputs[0]), val(inputs[1])];
        const bad = a == null || b == null || a >= b || (kind === "hour" && (a < 0 || a > 23 || b < 1 || b > 24));
        inputs.forEach(i => i.toggleClass("is-invalid", bad)); if (bad) return;
        (from[1] as (v: string | number) => void)(kind === "time" ? inputs[0].value : a!); (to[1] as (v: string | number) => void)(kind === "time" ? inputs[1].value : b!);
        await changed();
      };
      [from, to].forEach((pair, idx) => {
        if (idx) st.controlEl.createSpan({ cls: "samaya-range-sep", text: "to" });
        const i = st.controlEl.createEl("input", { type: kind === "time" ? "time" : "number", cls: kind === "time" ? "" : "samaya-num" });
        if (kind === "hour") { i.min = "0"; i.max = "24"; i.step = "1"; }
        i.value = String(pair[0]()); i.addEventListener("input", () => { void check(); }); inputs.push(i);
      });
    };

    const toggle = (el: HTMLElement, name: string, desc: string, get: () => boolean, set: (v: boolean) => void) =>
      new Setting(el).setName(name).setDesc(desc).addToggle(t => t.setValue(get()).onChange(async v => { set(v); await changed(); }));

    const dropdown = <T extends string>(el: HTMLElement, name: string, desc: string, opts: Record<T, string>, get: () => T, set: (v: T) => void | Promise<void>) =>
      new Setting(el).setName(name).setDesc(desc).addDropdown(d => { for (const k in opts) d.addOption(k, opts[k]); d.setValue(get()).onChange(async v => { await set(v as T); await changed(); }); });

    /** A path pattern with a live "Today: ..." preview. */
    const pathText = (el: HTMLElement, name: string, desc: string, key: "tasksPath" | "ticketsPath" | "meetingsPath", extra = "") => {
      const st = new Setting(el).setName(name);
      st.descEl.appendText(desc + " Date parts use moment.js format; put literal text in [brackets], e.g. [Meetings]/YYYY/YYYY-MM. ");
      st.descEl.createEl("a", { text: "Syntax reference", href: "https://momentjs.com/docs/#/displaying/format" });
      if (extra) st.descEl.createDiv({ text: extra });
      const preview = st.descEl.createDiv({ cls: "samaya-path-preview" });
      const show = () => preview.setText("Today: " + ((key === "ticketsPath" ? ticketFolderFor(s, SAMPLE_TICKET, new Date()) : folderFor(s[key], new Date())) || "(vault root)"));
      st.addText(t => t.setValue(s[key]).onChange(async v => { s[key] = v.trim() || DEFAULT_SETTINGS[key]; await changed(); show(); }));
      show();
    };
    const mdFiles = () => this.app.vault.getMarkdownFiles().map(f => f.path.replace(/\.md$/, "")).sort();
    const folders = () => this.app.vault.getAllFolders(false).map(f => f.path).sort();
    const template = (el: HTMLElement, name: string, desc: string, key: "taskTemplate" | "meetingTemplate" | "ticketTemplate") =>
      text(el, name, desc + " Leave empty for the built-in template.", () => s[key], v => (s[key] = v), { placeholder: "Templates/…", suggest: mdFiles });

    // ======================================================================== core modules
    new Setting(c).setName("Core modules").setHeading().setDesc("Always on. They make up the planner itself.").settingEl.addClass("samaya-section");

    {
      const b = card("Planner", "How your workday is shaped: when you work, how much you plan, and what counts as overtime.");
      label(b, "Workday");
      range(b, "Lunch break", "Marked in the calendar and subtracted from capacity.", "time",
        [() => s.lunchStart, v => (s.lunchStart = v)], [() => s.lunchEnd, v => (s.lunchEnd = v)]);
      toggle(b, "Add the default lunch automatically", "When you end the day without a logged lunch break, subtract the window above.", () => s.autoLunch, v => (s.autoLunch = v));
      num(b, "Daily capacity (hours)", "Plannable hours per day. Free capacity = this minus lunch minus calendar meetings.", () => s.capacityHours, v => (s.capacityHours = v), { min: 0.5, max: 24, step: 0.5 });
      text(b, "Shutdown reminder", "A nudge to run the shutdown ritual.", () => s.shutdownTime, v => (s.shutdownTime = v), { time: true });
      label(b, "Week");
      num(b, "Required hours per week", "Used by the work time dashboard for overtime.", () => s.weeklyHours, v => (s.weeklyHours = v), { min: 1, max: 168, step: 0.5 });
      num(b, "Working days per week", "Counted from Monday (5 = Mon–Fri). Work on other days is all overtime.", () => s.workDays, v => (s.workDays = v), { min: 1, max: 7, int: true });
      label(b, "Timeboxing grid");
      range(b, "Visible hours", "The part of the day shown on the grid.", "hour",
        [() => s.dayStartHour, v => (s.dayStartHour = v)], [() => s.dayEndHour, v => (s.dayEndHour = v)]);
      new Setting(b).setName("Snap to").setDesc("Timeboxing granularity.").addDropdown(d => {
        const opts = [5, 10, 15, 30, 60]; if (!opts.includes(s.slotMinutes)) opts.push(s.slotMinutes);
        for (const m of opts.sort((x, y) => x - y)) d.addOption(String(m), m === 60 ? "1 hour" : `${m} minutes`);
        d.setValue(String(s.slotMinutes)).onChange(async v => { s.slotMinutes = Number(v); await changed(); });
      });
      label(b, "Startup & files");
      toggle(b, "Open planner on startup", "Open today's planner whenever Obsidian starts.", () => s.openOnStartup, v => (s.openOnStartup = v));
      text(b, "Planner base file", "The base file opened by the ribbon icon.", () => s.plannerFile, v => (s.plannerFile = v || "Planner/Planner.base"), { placeholder: "Planner/Planner.base" });
      const dailyBox = b.createDiv(); // filled once we know which daily note sources exist
      void this.renderDailyNotes(dailyBox, changed);
    }

    {
      const b = card("Tasks", "One note per task, created from the planner, the backlog or a checkbox.");
      num(b, "Default estimate (minutes)", "Used for new tasks, and for unestimated tasks dropped on the grid.", () => s.defaultEstimate, v => (s.defaultEstimate = v), { min: 1, max: 1440, int: true });
      label(b, "Notes & templates");
      pathText(b, "Tasks path", "Where task notes are stored.", "tasksPath");
      template(b, "Task note template", "Path of a template note. Variables: {{title}} {{date}} {{date:FORMAT}} {{time}}. A “## Subtasks” heading is added if missing.", "taskTemplate");
    }

    // ======================================================================== optional modules
    new Setting(c).setName("Optional modules").setHeading().setDesc("Switch on what you use. Settings of a module you turn off are kept.").settingEl.addClass("samaya-section");

    {
      const ics = () => s.icsUrls.length;
      const b = card("Calendar", "Show meetings in the planner and create a note for each one.", {
        enabled: { get: () => s.calendarOn, set: v => { s.calendarOn = v; this.plugin.bus.emit(); } },
        status: () => s.calendarSource === "notes"
          ? (s.eventNotesFolder ? ["Notes", "ok"] : ["Needs a folder", "warn"])
          : (ics() ? [`${ics()} feed${ics() > 1 ? "s" : ""}`, "ok"] : ["Needs a feed URL", "warn"]),
      });
      label(b, "Events");
      dropdown(b, "Event source", "Read-only ICS feed, or notes that already exist in your vault.", { ics: "ICS feed", notes: "Notes in my vault" }, () => s.calendarSource, async v => { s.calendarSource = v; this.plugin.bus.emit(); });
      const srcBox = b.createDiv();
      const renderSrc = () => {
        srcBox.empty();
        if (s.calendarSource === "notes") {
          text(srcBox, "Event notes folder", "Searched recursively. Only notes whose file name matches the pattern below are used.", () => s.eventNotesFolder, v => (s.eventNotesFolder = v || "Meetings"), { placeholder: "Meetings", suggest: folders, after: () => this.plugin.bus.emit() });
          text(srcBox, "File name pattern", `${PATTERN_HELP}. Leave out “.md”.`, () => s.eventNotePattern, v => { if (compilePattern(v || DEFAULT_EVENT_PATTERN)) s.eventNotePattern = v || DEFAULT_EVENT_PATTERN; }, { placeholder: DEFAULT_EVENT_PATTERN });
          note(srcBox, "Each event note needs start and end properties (hh:mm, or yyyy-mm-dd hh:mm for events over midnight). The day comes from a date property (yyyy-mm-dd) or from {{date}} in the file name. Optional: title (otherwise {{title}} from the file name) and allday: true (then only the date is needed). Example: “2026-11-09_Sprint planning.md” with start: 10:00 and end: 11:00.");
        } else {
          new Setting(srcBox).setName("ICS URLs").setDesc("One per line: Google Calendar “secret address in iCal format”, Outlook, …")
            .addTextArea(t => { t.setValue(s.icsUrls.join("\n")).setPlaceholder("https://calendar.google.com/…/basic.ics").onChange(async v => { s.icsUrls = v.split("\n").map(x => x.trim().replace(/^webcal:/, "https:")).filter(Boolean); this.plugin.ics.clear(); await changed(); }); t.inputEl.rows = 3; t.inputEl.addClass("samaya-wide"); });
          num(srcBox, "Refresh interval (minutes)", "How long fetched calendars are cached.", () => s.icsRefreshMinutes, v => (s.icsRefreshMinutes = v), { min: 1, max: 1440, int: true });
          new Setting(srcBox).setName("Refresh now").setDesc(`Fetch the feeds again and create meeting notes for all events from ${MEETING_SYNC_DAYS.back} days ago to ${MEETING_SYNC_DAYS.ahead} days ahead.`).addButton(bt => bt.setButtonText("Refresh").onClick(async () => { this.plugin.ics.clear(); bt.setDisabled(true); const day = 86400000, now = Date.now(); const evs = await this.plugin.ics.eventsBetween(new Date(now - MEETING_SYNC_DAYS.back * day), new Date(now + MEETING_SYNC_DAYS.ahead * day)); const n = await generateMeetingNotes(this.app, s, evs); bt.setDisabled(false); this.plugin.bus.emit(); bt.setButtonText(`Refreshed ✓ (${n} new)`); window.setTimeout(() => bt.setButtonText("Refresh"), 1500); }));
          note(srcBox, "The feed URL is private. It is stored unencrypted in this plugin's data.json; don't sync that file to places you don't trust.");
        }
      };
      renderSrc();
      // the source dropdown changes which fields apply: rebuild only this block, not the page
      let shown = s.calendarSource; refreshers.push(() => { if (shown !== s.calendarSource) { shown = s.calendarSource; renderSrc(); renderMeet(); } });
      // with notes as the source every event already is a note, so nothing is created and these don't apply
      const meetBox = b.createDiv();
      const renderMeet = () => {
        meetBox.empty(); if (s.calendarSource === "notes") return;
        label(meetBox, "Meeting notes");
        pathText(meetBox, "Meetings path", "Where notes for calendar events are created (named yyyy-mm-dd_title).", "meetingsPath");
        template(meetBox, "Meeting note template", "Path of a template note. Variables: {{title}} {{date}} {{start}} {{end}}.", "meetingTemplate");
      };
      renderMeet();
    }

    const secrets = "Tokens are stored unencrypted in this plugin's data.json inside the vault. Don't sync that file to places you don't trust.";
    const syncBtn = (el: HTMLElement, which: "jira" | "gitlab", name: string) =>
      new Setting(el).setName("Import now").setDesc(`Fetch your ${name} issues into the tickets path.`).addButton(bt => bt.setButtonText(`Sync ${name}`).setCta().onClick(async () => { bt.setDisabled(true); try { await this.plugin.syncTickets(which); } finally { bt.setDisabled(false); } }));

    {
      const b = card("Jira", "Import the issues assigned to you as ticket notes.", {
        enabled: { get: () => s.jiraOn, set: v => { s.jiraOn = v; } },
        status: () => (s.jiraUrl && s.jiraToken && (s.jiraFlavor === "server" || s.jiraEmail)) ? ["Configured", "ok"] : ["Needs setup", "warn"],
      });
      label(b, "Connection");
      dropdown(b, "Flavor", "Cloud: email + API token. Server / Data Center: personal access token.", { cloud: "Jira Cloud", server: "Server / Data Center" }, () => s.jiraFlavor, v => { s.jiraFlavor = v; renderEmail(); });
      text(b, "Base URL", "e.g. https://yourteam.atlassian.net", () => s.jiraUrl, v => (s.jiraUrl = v.replace(/\/+$/, "")), { placeholder: "https://yourteam.atlassian.net" });
      const emailBox = b.createDiv();
      const renderEmail = () => { emailBox.empty(); if (s.jiraFlavor === "cloud") text(emailBox, "Email", "The account the API token belongs to.", () => s.jiraEmail, v => (s.jiraEmail = v), { placeholder: "you@company.com" }); };
      renderEmail();
      text(b, "Token", "Cloud: API token. Server / Data Center: personal access token.", () => s.jiraToken, v => (s.jiraToken = v), { secret: true });
      note(b, secrets);
      label(b, "Import");
      text(b, "JQL", "Which issues to import.", () => s.jiraJql, v => (s.jiraJql = v), { placeholder: DEFAULT_SETTINGS.jiraJql });
      syncBtn(b, "jira", "Jira");
      refreshers.push(() => { if (!!emailBox.firstChild !== (s.jiraFlavor === "cloud")) renderEmail(); });
    }

    {
      const b = card("GitLab", "Import GitLab issues as ticket notes.", {
        enabled: { get: () => s.gitlabOn, set: v => { s.gitlabOn = v; } },
        status: () => (s.gitlabUrl && s.gitlabToken) ? ["Configured", "ok"] : ["Needs setup", "warn"],
      });
      label(b, "Connection");
      text(b, "Base URL", "https://gitlab.com or your self-hosted URL.", () => s.gitlabUrl, v => (s.gitlabUrl = v.replace(/\/+$/, "")), { placeholder: "https://gitlab.com" });
      text(b, "Personal access token", "Scope: read_api.", () => s.gitlabToken, v => (s.gitlabToken = v), { secret: true });
      note(b, secrets);
      label(b, "Import");
      dropdown(b, "Issues to import", "", { assigned_to_me: "Assigned to me", created_by_me: "Created by me", all: "All I can see" }, () => s.gitlabScope, v => { s.gitlabScope = v; });
      syncBtn(b, "gitlab", "GitLab");
    }

    {
      const b = card("Tickets", "Ticket notes imported from Jira and GitLab. Both share these settings. Appears when either is on.", { activeWhen: () => s.jiraOn || s.gitlabOn });
      label(b, "Notes & templates");
      pathText(b, "Tickets path", "Where ticket notes are stored.", "ticketsPath", `May contain ticket variables (${vars(TICKET_VARIABLES)}), e.g. [Tickets]/{{TICKET_SOURCE}}/{{TICKET_STATUS}} ({{TICKET_SOURCE}} is JIRA or GITLAB). With {{TICKET_STATUS}}, notes move when the ticket's status changes.`);
      const fn = new Setting(b).setName("Ticket file name").setDesc("Ticket variables in double braces, plus {{TICKET_TITLE_SLUG}} (the title as a slug). Leave out “.md”.");
      const fnPreview = fn.descEl.createDiv({ cls: "samaya-path-preview" });
      const showFn = () => fnPreview.setText("Example: " + renderTicketFileName(s.ticketFileName, SAMPLE_TICKET) + ".md");
      fn.addText(t => t.setValue(s.ticketFileName).setPlaceholder(DEFAULT_SETTINGS.ticketFileName).onChange(async v => { s.ticketFileName = v.trim() || DEFAULT_SETTINGS.ticketFileName; await changed(); showFn(); })); showFn();
      template(b, "Ticket note template", `Path of a template note. Variables: ${vars(TICKET_VARIABLES)} {{date}}.`, "ticketTemplate");
      label(b, "Sync");
      toggle(b, "Sync on startup", "Import tickets from the enabled integrations when Obsidian starts.", () => s.syncOnStartup, v => (s.syncOnStartup = v));
    }
  }
}
