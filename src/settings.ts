import { AbstractInputSuggest, App, ColorComponent, PluginSettingTab, Setting, TextComponent, setIcon } from "obsidian";
import type SamayaPlugin from "./main";
import { ticketFolderFor, folderFor } from "./model";
import { normalizeHex, resolveColor } from "./colors";
import { TICKET_VARIABLES, renderTicketFileName, TicketVars } from "./taskbody";
import { JournalLoc, JournalPart, PERIODIC_KINDS, PeriodicKind, JournalSource, PERIOD_DEFAULT_FORMAT, Period, journalLocation, journalPathFor, journalSources, pickJournalSource } from "./journal";
import { DEFAULT_EVENT_PATTERN, PATTERN_HELP, compilePattern } from "./eventnotes";

export interface PeriodCfg { on: boolean; source: "auto" | JournalSource; folder: string; format: string; }
export interface SamayaSettings {
  tasksPath: string; ticketsPath: string; journalSource: "auto" | JournalSource; journalFolder: string; journalFormat: string;
  taskTemplate: string; ticketTemplate: string; ticketFileName: string;
  eventNotesFolder: string; eventNotePattern: string;
  /** Planner: plan Saturday and Sunday too; count calendar events as busy time */
  plannerWeekends: boolean; plannerShowIcs: boolean;
  dayStartHour: number; dayEndHour: number; slotMinutes: number;
  defaultEstimate: number; shutdownTime: string; dayStartTime: string; openOnStartup: boolean;
  jiraFlavor: "cloud" | "server"; jiraUrl: string; jiraEmail: string; jiraToken: string; jiraJql: string;
  gitlabUrl: string; gitlabToken: string; gitlabScope: "assigned_to_me" | "created_by_me" | "all";
  syncOnStartup: boolean;
  lunchStart: string; lunchEnd: string; weeklyHours: number; workDays: number; /** all-day events with this word in the title mark vacation days ("" = off) */ vacationKeyword: string; /** % of every day's free time to keep unplanned */ bufferPercent: number; /** hex colour of tasks everywhere ("" = theme accent) */ taskColor: string; /** hex colour of meetings everywhere ("" = cyan) */ meetingColor: string; autoLunch: boolean;
  /** optional modules; off by default for new installs */
  calendarOn: boolean; jiraOn: boolean; gitlabOn: boolean;
  /** journal module: write into the daily note, and which parts */
  journalOn: boolean; journalPlanned: boolean; journalFinished: boolean; journalTomorrow: boolean;
  journalWorkTimes: boolean; journalBreaks: boolean; journalTracked: boolean;
  /** parts of the weekly note written when the week plan is finished */ journalWeekPlan: boolean; journalWeekMeetings: boolean; journalWeekTasks: boolean;
  /** weekly / monthly / quarterly / yearly notes of the journal calendar */
  journalNotes: Record<PeriodicKind, PeriodCfg>;
  /** hide the title and properties block in journal notes */
  journalHideProps: boolean;
  /** open the daily / weekly note right after finishing the day / week plan */
  journalOpenAfterPlan: boolean;
  /** navigation bar above journal notes */
  journalNavBar: boolean;
  /** projects module: folder of project notes and the base that shows them */
  projectsOn: boolean; projectsPath: string; projectsBase: string;
  /** home page: a base file with the Home view, at the vault root by default */
  homeOn: boolean; homePath: string; homeOnStartup: boolean;
}
export const DEFAULT_SETTINGS: SamayaSettings = {
  tasksPath: "[Tasks]/YYYY/YYYY-MM", ticketsPath: "[Tickets]/{{TICKET_SOURCE}}/{{TICKET_STATUS}}", journalSource: "auto", journalFolder: "[Journal]/YYYY/YYYY-MM", journalFormat: "YYYY-MM-DD", taskTemplate: "", ticketTemplate: "", ticketFileName: "{{TICKET_ID}}_{{TICKET_TITLE_SLUG}}",
  eventNotesFolder: "Meetings", eventNotePattern: "{{date}}_{{title}}",
  plannerWeekends: false, plannerShowIcs: true,
  dayStartHour: 7, dayEndHour: 20, slotMinutes: 5, defaultEstimate: 30, shutdownTime: "17:00", dayStartTime: "08:00", openOnStartup: false,
  jiraFlavor: "cloud", jiraUrl: "", jiraEmail: "", jiraToken: "",
  jiraJql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
  gitlabUrl: "https://gitlab.com", gitlabToken: "", gitlabScope: "assigned_to_me", syncOnStartup: false,
  lunchStart: "12:00", lunchEnd: "13:00", weeklyHours: 40, workDays: 5, vacationKeyword: "Urlaub", bufferPercent: 20, taskColor: "#8fcfa6", meetingColor: "#8db8f0", autoLunch: true,
  calendarOn: false, jiraOn: false, gitlabOn: false,
  journalOn: false, journalPlanned: true, journalFinished: true, journalTomorrow: true,
  journalWorkTimes: true, journalBreaks: true, journalTracked: true, journalWeekPlan: true, journalWeekMeetings: true, journalWeekTasks: true,
  journalHideProps: true, journalOpenAfterPlan: false, journalNavBar: true,
  journalNotes: {
    weekly: { on: false, source: "auto", folder: "[Journal]/YYYY/[Weekly]", format: PERIOD_DEFAULT_FORMAT.weekly },
    monthly: { on: false, source: "auto", folder: "[Journal]/YYYY/YYYY-MM", format: PERIOD_DEFAULT_FORMAT.monthly },
    quarterly: { on: false, source: "auto", folder: "[Journal]/YYYY/[Quarterly]", format: PERIOD_DEFAULT_FORMAT.quarterly },
    yearly: { on: false, source: "auto", folder: "[Journal]/YYYY", format: PERIOD_DEFAULT_FORMAT.yearly },
  },
  projectsOn: false, projectsPath: "Projects", projectsBase: "Projects/Projects.base",
  homeOn: false, homePath: "Home.base", homeOnStartup: false,
};

/** Settings saved by older versions used plain folders; turn them into equivalent path patterns. */
export function migrateSettings(saved: Record<string, unknown>): Partial<SamayaSettings> {
  const o = { ...saved } as Record<string, unknown>;
  const lit = (v: unknown) => `[${String(v).replace(/[[\]]/g, "")}]`;
  if (o.tasksFolder != null && o.tasksPath == null) o.tasksPath = lit(o.tasksFolder) + "/YYYY/MM";
  if (o.ticketsFolder != null && o.ticketsPath == null) o.ticketsPath = lit(o.ticketsFolder);
  // optional modules were implicit before: keep the ones that were already set up
  if (o.calendarOn == null) o.calendarOn = !!o.eventNotesFolder;
  if (o.jiraOn == null) o.jiraOn = !!(o.jiraUrl && o.jiraToken);
  if (o.gitlabOn == null) o.gitlabOn = !!o.gitlabToken;
  if (o.journalOn == null) o.journalOn = Object.keys(saved).length > 0; // the journal was always on for existing installs
  // ticket variables were called TASK_* before
  for (const k of ["ticketsPath", "ticketFileName"]) if (typeof o[k] === "string") o[k] = (o[k] as string).replace(/\bTASK_/g, "TICKET_");
  // the daily note folder is a path pattern now: a plain name becomes a literal
  if (typeof o.journalFolder === "string" && o.journalFolder.trim() && !o.journalFolder.includes("[")) o.journalFolder = `[${o.journalFolder.trim().replace(/[[\]]/g, "")}]`;
  const dj = DEFAULT_SETTINGS.journalNotes; const sj = (o.journalNotes ?? {}) as Partial<typeof dj>;
  // locations still at the first defaults (flat folders) move to the current defaults
  const OLD: Record<string, [string, string]> = { weekly: ["[Journal]/Weekly", "gggg-[W]ww"], monthly: ["[Journal]/Monthly", "YYYY-MM"], yearly: ["[Journal]/Yearly", "YYYY"] };
  const jn = {} as Record<string, PeriodCfg>;
  for (const k of PERIODIC_KINDS) {
    const c = { ...(sj[k] ?? {}) } as Partial<PeriodCfg>;
    if (OLD[k] && c.folder === OLD[k][0] && c.format === OLD[k][1]) { delete c.folder; delete c.format; }
    jn[k] = { ...dj[k], ...c };
  }
  o.journalNotes = jn;
  delete o.tasksFolder; delete o.ticketsFolder; delete o.meetingsFolder;
  return o as Partial<SamayaSettings>;
}

const JOURNAL_PARTS: Array<[JournalPart, string, string]> = [
  ["journalPlanned", "Planned tasks", "“Planned tasks” section, written when you finish the morning planning."],
  ["journalFinished", "Finished tasks", "“Finished tasks” section, written at shutdown (with the tracked time per task)."],
  ["journalTomorrow", "Tomorrow's plan", "“Planned for tomorrow” section, written at shutdown."],
  ["journalWorkTimes", "Work start & end", "work_start and work_end properties."],
  ["journalBreaks", "Breaks & lunch", "breaks, break_minutes and lunch properties."],
  ["journalTracked", "Tracked work time", "work_minutes property: total time worked that day."],
];
const JOURNAL_WEEK_PARTS: Array<[JournalPart, string, string]> = [
  ["journalWeekPlan", "Overview", "“Overview” section: totals and a table with tasks, meetings, unplanned time and load for every day. Written when you finish planning the week."],
  ["journalWeekMeetings", "Meetings", "“Meetings” section: the week's meetings by weekday, linked to their meeting notes. Written when you finish planning the week."],
  ["journalWeekTasks", "Planned tasks", "“Planned tasks” section: the week's tasks with their day and time. Written when you finish planning the week."],
];
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
  private activeTab = "planner";
  constructor(app: App, private plugin: SamayaPlugin) { super(app, plugin); }

  /** Where notes of one kind live: offer only the sources that are installed and enabled right now. */
  private async renderLocation(box: HTMLElement, p: Period, changed: () => Promise<void>) {
    const s = this.plugin.settings;
    // daily notes keep their settings at the top level; the other kinds live in journalNotes
    const f = p === "daily"
      ? { src: () => s.journalSource, setSrc: (v: "auto" | JournalSource) => { s.journalSource = v; }, folder: () => s.journalFolder, setFolder: (v: string) => { s.journalFolder = v; }, format: () => s.journalFormat, setFormat: (v: string) => { s.journalFormat = v; } }
      : (() => { const n = s.journalNotes[p]; return { src: () => n.source, setSrc: (v: "auto" | JournalSource) => { n.source = v; }, folder: () => n.folder, setFolder: (v: string) => { n.folder = v; }, format: () => n.format, setFormat: (v: string) => { n.format = v; } }; })();
    const dflt = PERIOD_DEFAULT_FORMAT[p];
    const what = p;
    const draw = async () => {
      const avail = await journalSources(this.app, p);
      const source = pickJournalSource(avail, f.src());
      const loc: JournalLoc = source === "custom" ? { folder: f.folder().trim(), format: f.format().trim() || dflt, pattern: true } : avail[source]!;
      if (!box.isConnected) return; box.empty();
      const names: Record<JournalSource, string> = { daily: "Daily notes (core plugin)", periodic: "Periodic Notes (community plugin)", custom: "Custom folder" };
      const options = (["periodic", "daily"] as const).filter(k => avail[k]).map(k => k as JournalSource).concat("custom");
      if (options.length > 1) {
        new Setting(box).setName(`${p === "daily" ? "Daily" : p[0].toUpperCase() + p.slice(1)} note location`).setDesc(`Where the planner reads and writes your ${what} notes.`)
          .addDropdown(d => { for (const k of options) d.addOption(k, names[k]); d.setValue(source).onChange(async v => { f.setSrc(v as JournalSource); await changed(); void draw(); }); });
      }
      // folder + file name form one path: grouped by an accent rule and closed by a shared preview
      const group = box.createDiv("samaya-pathgroup");
      const result = group.createDiv("samaya-pathresult");
      const show = (l: JournalLoc) => {
        const path = journalPathFor(l, new Date().toLocaleDateString("sv")); const i = path.lastIndexOf("/");
        result.empty(); result.createSpan({ cls: "samaya-pathresult-label", text: p === "daily" ? "Today's note" : `This ${p.replace("ly", "")}'s note` });
        const code = result.createEl("code");
        if (i >= 0) code.createSpan({ cls: "samaya-pathresult-dir", text: path.slice(0, i + 1) });
        code.createSpan({ cls: "samaya-pathresult-file", text: path.slice(i + 1) });
      };
      const rows = (folderSt: Setting, fileSt: Setting) => { group.insertBefore(folderSt.settingEl, result); group.insertBefore(fileSt.settingEl, result); };
      if (source === "custom") {
        const cur = (): JournalLoc => ({ folder: f.folder().trim(), format: f.format().trim() || dflt, pattern: true });
        const folderSt = new Setting(group).setName("Folder");
        folderSt.descEl.appendText("A folder pattern. Date parts use moment.js format; put literal text in [brackets], e.g. [Journal]/YYYY. ");
        folderSt.descEl.createEl("a", { text: "Syntax reference", href: "https://momentjs.com/docs/#/displaying/format" });
        if (options.length === 1) folderSt.descEl.createDiv({ text: p === "daily" ? "Enable the Daily notes core plugin or Periodic Notes and you can use their settings here instead." : `Install Periodic Notes and enable its ${what} notes and you can use its settings here instead.` });
        folderSt.addText(t => t.setValue(f.folder()).setPlaceholder("[Journal]/YYYY").onChange(async v => { f.setFolder(v.trim()); await changed(); show(cur()); }));
        const fileSt = new Setting(group).setName("File name").setDesc("moment.js format of the note's name, without “.md”.");
        fileSt.addText(t => t.setValue(f.format()).setPlaceholder(dflt).onChange(async v => { f.setFormat(v.trim() || dflt); await changed(); show(cur()); }));
        rows(folderSt, fileSt); show(cur());
      } else {
        const where = source === "daily" ? "Settings › Daily notes" : "Settings › Periodic Notes";
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

    // ---- tabs: one panel per module, only the active one is shown
    const bar = c.createDiv({ cls: "samaya-tabs", attr: { role: "tablist" } });
    const tabs: Array<{ id: string; btn: HTMLElement; panel: HTMLElement }> = [];
    let cur: HTMLElement = c;
    const select = (id: string) => {
      this.activeTab = id;
      for (const t of tabs) { const on = t.id === id; t.btn.toggleClass("is-active", on); t.btn.setAttribute("aria-selected", String(on)); t.btn.tabIndex = on ? 0 : -1; t.panel.toggleClass("is-active", on); }
    };
    const tabDivider = () => bar.createDiv("samaya-tabs-sep");
    const tab = (id: string, name: string, icon: string) => {
      const btn = bar.createEl("button", { cls: "samaya-tab", attr: { role: "tab", type: "button" } });
      setIcon(btn.createSpan("samaya-tab-icon"), icon); btn.createSpan({ cls: "samaya-tab-name", text: name });
      const panel = c.createDiv({ cls: "samaya-panel", attr: { role: "tabpanel" } });
      btn.addEventListener("click", () => select(id));
      btn.addEventListener("keydown", e => {
        const i = tabs.findIndex(t => t.id === id), d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return;
        const n = tabs[(i + d + tabs.length) % tabs.length]; select(n.id); n.btn.focus(); e.preventDefault();
      });
      tabs.push({ id, btn, panel }); cur = panel; return btn;
    };
    const changed = async () => { await save(); refreshers.forEach(f => f()); };

    // ---- building blocks
    const label = (el: HTMLElement, text: string) => el.createDiv({ cls: "samaya-group-label", text });
    const note = (el: HTMLElement, text: string, cls = "") => el.createDiv({ cls: "samaya-note " + cls, text });

    /** One module: a header (with an on/off switch when optional) and a body that folds away while it is off. */
    const card = (title: string, desc: string, opts: CardOpts = {}) => {
      const el = cur.createDiv("samaya-mod");
      const dot = opts.status || opts.activeWhen ? tabs[tabs.length - 1].btn.createSpan("samaya-tab-dot") : null;
      const head = new Setting(el).setName(title).setDesc(desc);
      head.settingEl.addClass("samaya-mod-head");
      const pill = opts.status ? head.nameEl.createSpan("samaya-pill") : null;
      const inner = el.createDiv("samaya-mod-body").createDiv("samaya-mod-inner");
      const sync = () => {
        const on = opts.enabled ? opts.enabled.get() : opts.activeWhen ? opts.activeWhen() : true;
        el.toggleClass("is-off", !on); inner.parentElement?.toggleAttribute("inert", !on);
        if (pill && opts.status) { const [t, k] = on ? opts.status() : ["Off", "off" as const]; pill.setText(t); pill.className = "samaya-pill is-" + k; if (dot) dot.className = "samaya-tab-dot is-" + k; }
        else if (dot) dot.className = "samaya-tab-dot is-" + (on ? "ok" : "off");
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
    const pathText = (el: HTMLElement, name: string, desc: string, key: "tasksPath" | "ticketsPath", extra = "") => {
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
    const template = (el: HTMLElement, name: string, desc: string, key: "taskTemplate" | "ticketTemplate") =>
      text(el, name, desc + " Leave empty for the built-in template.", () => s[key], v => (s[key] = v), { placeholder: "Templates/…", suggest: mdFiles });

    // ======================================================================== core modules
    tab("home", "Home", "home");
    {
      const b = card("Home", "A calm start page: where you are in the day and the week, and the next step (plan or start the day, plan or review the week, shut down).", {
        enabled: { get: () => s.homeOn, set: async v => { s.homeOn = v; await save(); if (v) await this.plugin.scaffoldHome(true); } },
        status: () => s.homePath.trim() ? ["On", "ok"] : ["Needs a path", "warn"],
      });
      const st = new Setting(b).setName("Home page file").setDesc("Where the page lives, relative to the vault root. A “.base” extension is added if missing. Changing it moves the existing page.");
      st.addText(t => {
        t.setValue(s.homePath).setPlaceholder("Home.base");
        new PathSuggest(this.app, t.inputEl, () => this.app.vault.getFiles().filter(f => f.extension === "base").map(f => f.path).sort());
        const commit = async () => {
          const next = t.inputEl.value.trim() || DEFAULT_SETTINGS.homePath;
          if (next === s.homePath) return;
          const prev = s.homePath; s.homePath = next; t.inputEl.value = next;
          await changed(); if (s.homeOn) await this.plugin.moveHome(prev, next);
        };
        t.inputEl.addEventListener("blur", () => { void commit(); });
        t.inputEl.addEventListener("keydown", e => { if (e.key === "Enter") t.inputEl.blur(); });
      });
      new Setting(b).setName("Open").setDesc("Create the page if it is missing, then open it.")
        .addButton(bt => bt.setButtonText("Open home").onClick(async () => { await this.plugin.openHome(); }));
      toggle(b, "Open home on startup", "Show the home page whenever Obsidian starts.", () => s.homeOnStartup, v => (s.homeOnStartup = v));
    }

    tab("planner", "Planner", "layout-dashboard");

    {
      const b = card("Planner", "How your workday is shaped: when you work, how much you plan, and what counts as overtime.");
      label(b, "Workday");
      range(b, "Workday", "Start and end of your plannable day. Free capacity = start to end, minus lunch and meetings. The end is also when the shutdown reminder appears. Drag the start and finish lines in the planner timeline to change it.", "time",
        [() => s.dayStartTime, v => (s.dayStartTime = v)], [() => s.shutdownTime, v => (s.shutdownTime = v)]);
      range(b, "Lunch break", "Marked in the calendar and subtracted from capacity.", "time",
        [() => s.lunchStart, v => (s.lunchStart = v)], [() => s.lunchEnd, v => (s.lunchEnd = v)]);
      toggle(b, "Add the default lunch automatically", "When you end the day without a logged lunch break, subtract the window above.", () => s.autoLunch, v => (s.autoLunch = v));
      label(b, "Week");
      num(b, "Required hours per week", "Used by the work time dashboard for overtime.", () => s.weeklyHours, v => (s.weeklyHours = v), { min: 1, max: 168, step: 0.5 });
      num(b, "Working days per week", "Counted from Monday (5 = Mon–Fri). Work on other days is all overtime.", () => s.workDays, v => (s.workDays = v), { min: 1, max: 7, int: true });
      text(b, "Vacation keyword", "All-day calendar events with this word in the title (e.g. Urlaub, Vacation) count as vacation days: the past-week average work time in the planner heading leaves them out. Empty = off.", () => s.vacationKeyword, v => (s.vacationKeyword = v.trim()), { placeholder: "Urlaub" });
      label(b, "Planning");
      num(b, "Free buffer (%)", "Share of every day's free time to keep unplanned, for unforeseen meetings and tasks. Plan my day and Plan my week turn orange past it and red when the day is over capacity.", () => s.bufferPercent, v => (s.bufferPercent = v), { min: 0, max: 90, int: true });
      label(b, "Colours");
      const colour = (name: string, desc: string, key: "taskColor" | "meetingColor", fallback: string) => {
        const def = resolveColor(fallback) || "#808080";
        let pick: ColorComponent | undefined; let hex: TextComponent | undefined; // the picker and the hex field show the same colour
        new Setting(b).setName(name).setDesc(desc)
          .addColorPicker(c => { pick = c; c.setValue(s[key] || def).onChange(async v => { s[key] = v; hex?.setValue(v); hex?.inputEl.removeClass("is-invalid"); await changed(); }); })
          .addText(t => {
            hex = t; t.setPlaceholder("#rrggbb").setValue(s[key] || def); t.inputEl.size = 8; t.inputEl.spellcheck = false; t.inputEl.setAttr("aria-label", `${name} as hex code`);
            t.onChange(async v => { const h = normalizeHex(v); t.inputEl.toggleClass("is-invalid", !h); if (!h) return; s[key] = h; pick?.setValue(h); await changed(); });
          })
          .addExtraButton(x => x.setIcon("rotate-ccw").setTooltip("Back to the theme colour").onClick(async () => { s[key] = ""; await changed(); this.display(); }));
      };
      colour("Task colour", "Tasks on the timelines, in the check step and in the week plan.", "taskColor", "#8fcfa6");
      colour("Meeting colour", "Calendar meetings on the timelines, in the check step and in the week plan.", "meetingColor", "#8db8f0");
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
      toggle(b, "Show weekends", "Plan Saturday and Sunday in the week views too.", () => s.plannerWeekends, v => { s.plannerWeekends = v; this.plugin.bus.emit(); this.plugin.refreshPlanner(); });
      toggle(b, "Count calendar events as busy", "Meetings from your calendar take up time in the planner.", () => s.plannerShowIcs, v => { s.plannerShowIcs = v; this.plugin.bus.emit(); this.plugin.refreshPlanner(); });
    }

    tab("tasks", "Tasks", "check-square");
    {
      const b = card("Tasks", "One note per task, created from the planner, the backlog or a checkbox.");
      num(b, "Default estimate (minutes)", "Used for new tasks, and for unestimated tasks dropped on the grid.", () => s.defaultEstimate, v => (s.defaultEstimate = v), { min: 1, max: 1440, int: true });
      label(b, "Notes & templates");
      pathText(b, "Tasks path", "Where task notes are stored.", "tasksPath");
      template(b, "Task note template", "Path of a template note. Variables: {{title}} {{date}} {{date:FORMAT}} {{time}}. A “## Subtasks” heading is added if missing.", "taskTemplate");
    }

    // ======================================================================== optional modules
    tabDivider();
    tab("calendar", "Calendar", "calendar");

    {
      const b = card("Calendar", "Show meetings in the planner, from notes that already exist in your vault.", {
        enabled: { get: () => s.calendarOn, set: v => { s.calendarOn = v; this.plugin.bus.emit(); } },
        status: () => s.eventNotesFolder ? ["Notes", "ok"] : ["Needs a folder", "warn"],
      });
      label(b, "Events");
      text(b, "Event notes folder", "Searched recursively. Only notes whose file name matches the pattern below are used.", () => s.eventNotesFolder, v => (s.eventNotesFolder = v || "Meetings"), { placeholder: "Meetings", suggest: folders, after: () => this.plugin.bus.emit() });
      text(b, "File name pattern", `${PATTERN_HELP}. Leave out “.md”.`, () => s.eventNotePattern, v => { if (compilePattern(v || DEFAULT_EVENT_PATTERN)) s.eventNotePattern = v || DEFAULT_EVENT_PATTERN; }, { placeholder: DEFAULT_EVENT_PATTERN });
      note(b, "Each event note needs start and end properties (hh:mm, or yyyy-mm-dd hh:mm for events over midnight). The day comes from a date property (yyyy-mm-dd) or from {{date}} in the file name. Optional: title (otherwise {{title}} from the file name) and allday: true (then only the date is needed). Example: “2026-11-09_Sprint planning.md” with start: 10:00 and end: 11:00.");
    }

    tab("journal", "Journal", "book-open");
    {
      const b = card("Journal", "Write your day into your daily (periodic) note: plans, results and work times.", {
        enabled: { get: () => s.journalOn, set: v => { s.journalOn = v; if (v) void this.plugin.scaffoldJournal(false); else this.plugin.syncJournalSidebar(); this.plugin.bus.emit(); } },
        status: () => { const n = JOURNAL_PARTS.filter(([k]) => s[k]).length; return n ? [`${n} of ${JOURNAL_PARTS.length} items`, "ok"] : ["Nothing selected", "warn"]; },
      });
      toggle(b, "Hide title and properties in journal notes", "Hides the note title and the properties block at the top of your daily, weekly, monthly, quarterly and yearly notes. The properties are still there (work times are stored in them); turn this off to see and edit them.", () => s.journalHideProps, v => { s.journalHideProps = v; this.plugin.bus.emit(); });
      toggle(b, "Open the note after planning", "Opens the daily note when you finish planning your day, and the weekly note when you finish planning your week. Off: a button in the confirmation message opens it instead.", () => s.journalOpenAfterPlan, v => { s.journalOpenAfterPlan = v; });
      toggle(b, "Navigation bar in journal notes", "Shows a bar above your daily, weekly, monthly, quarterly and yearly notes to jump to the previous / next note, to today, or to the note of another period.", () => s.journalNavBar, v => { s.journalNavBar = v; this.plugin.bus.emit(); });
      label(b, "Write into the daily note");
      for (const [k, name, desc] of JOURNAL_PARTS) toggle(b, name, desc, () => s[k], v => (s[k] = v));
      note(b, "The work time dashboard and per-day lunch overrides read work times, breaks and lunch from the daily notes. Turn those items off and the dashboard shows nothing new, and a lunch changed on the grid lasts only until Obsidian restarts.");
      label(b, "Daily note location");
      const dailyBox = b.createDiv(); // filled once we know which daily note sources exist
      const changedJ = async () => { await changed(); this.plugin.bus.emit(); };
      void this.renderLocation(dailyBox, "daily", changedJ);
      label(b, "Periodic notes");
      note(b, "The journal calendar in the right sidebar opens the daily note when you click a day. Switch on weekly, monthly, quarterly and yearly notes to also open them from the week numbers, the month, the quarter and the year.");
      for (const [p, name, desc] of [["weekly", "Weekly notes", "Click a week number in the calendar."], ["monthly", "Monthly notes", "Click the month name in the calendar."], ["quarterly", "Quarterly notes", "Click the quarter (Q1-Q4) under the month in the calendar."], ["yearly", "Yearly notes", "Click the year in the calendar."]] as const) {
        const cfg = s.journalNotes[p];
        toggle(b, name, desc, () => cfg.on, v => { cfg.on = v; this.plugin.bus.emit(); });
        const box = b.createDiv(); void this.renderLocation(box, p, changedJ);
        const vis = () => { box.style.display = cfg.on ? "" : "none"; }; vis(); refreshers.push(vis);
      }
      const weekBox = b.createDiv(); // only while weekly notes are on
      label(weekBox, "Write into the weekly note");
      for (const [k, name, desc] of JOURNAL_WEEK_PARTS) toggle(weekBox, name, desc, () => s[k], v => (s[k] = v));
      const weekVis = () => { weekBox.style.display = s.journalNotes.weekly.on ? "" : "none"; }; weekVis(); refreshers.push(weekVis);
    }

    tab("projects", "Projects", "folder-kanban");
    {
      const b = card("Projects", "Group tasks and tickets into projects, and plan them on a Gantt chart.", {
        enabled: { get: () => s.projectsOn, set: v => { s.projectsOn = v; if (v) { void this.plugin.scaffoldProjects(true); this.plugin.scheduleTaskLists(); } this.plugin.bus.emit(); } },
        status: () => s.projectsPath.trim() ? ["On", "ok"] : ["Needs a folder", "warn"],
      });
      text(b, "Projects folder", "One note per project, with start, end and status properties.", () => s.projectsPath, v => (s.projectsPath = v.replace(/\/+$/, "") || "Projects"), { placeholder: "Projects", suggest: folders });
      text(b, "Projects base file", "The base with the Gantt chart and the Add project button.", () => s.projectsBase, v => (s.projectsBase = v || "Projects/Projects.base"), { placeholder: "Projects/Projects.base" });
      new Setting(b).setName("Create and open").setDesc("Create the folder and base if they are missing, then open the base.")
        .addButton(bt => bt.setButtonText("Open projects").onClick(async () => { await this.plugin.openProjects(); }));
      note(b, "Assign a task from its right-click menu in the planner, or any task or ticket note with the “Assign to a project” command. The link is stored in the assigned_project property.");
    }

    const secrets = "Tokens are stored unencrypted in this plugin's data.json inside the vault. Don't sync that file to places you don't trust.";
    const syncBtn = (el: HTMLElement, which: "jira" | "gitlab", name: string) =>
      new Setting(el).setName("Import now").setDesc(`Fetch your ${name} issues into the tickets path.`).addButton(bt => bt.setButtonText(`Sync ${name}`).setCta().onClick(async () => { bt.setDisabled(true); try { await this.plugin.syncTickets(which); } finally { bt.setDisabled(false); } }));

    tabDivider();
    tab("jira", "Jira", "ticket");
    {
      const b = card("Jira", "Import the issues assigned to you as ticket notes.", {
        enabled: { get: () => s.jiraOn, set: v => { s.jiraOn = v; if (v) { void this.plugin.scaffoldTickets(false); this.plugin.scheduleTaskLists(); } } },
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

    tab("gitlab", "GitLab", "git-merge");
    {
      const b = card("GitLab", "Import GitLab issues as ticket notes.", {
        enabled: { get: () => s.gitlabOn, set: v => { s.gitlabOn = v; if (v) void this.plugin.scaffoldTickets(false); } },
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

    tab("tickets", "Tickets", "list-checks");
    {
      const b = card("Tickets", "Ticket notes imported from Jira and GitLab. Both share these settings. Appears when either is on.", { activeWhen: () => s.jiraOn || s.gitlabOn });
      note(b, "A kanban board of all tickets (columns: status, rows: Jira / GitLab project) lives in Tickets.base inside the tickets folder.");
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
    select(tabs.some(t => t.id === this.activeTab) ? this.activeTab : tabs[0].id);
  }
}
