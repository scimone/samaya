import { Editor, MarkdownView, Notice, Plugin, TFile, normalizePath, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, SamayaSettings, SamayaSettingTab, migrateSettings } from "./settings";
import { FOCUS_VIEW_TYPE, FocusManager, FocusState, FocusView } from "./focus";
import { IcsClient, allTickets, assignTicket, createTask, momentFmt } from "./model";
import { DAILY_VIEW_TYPE, DailyPlannerView } from "./views/DailyPlannerView";
import { WEEK_VIEW_TYPE, WeeklyBoardView } from "./views/WeeklyBoardView";
import { WTL_VIEW_TYPE, WeeklyTimelineView } from "./views/WeeklyTimelineView";
import { BACKLOG_VIEW_TYPE, BacklogView } from "./views/BacklogView";
import { BACKLOG_BUCKETS_VIEW_TYPE, BacklogBucketsView } from "./views/BacklogBucketsView";
import { syncTickets } from "./sync";
import { syncMeetingNotes } from "./meetings";
import { TODAY_VIEW_TYPE, TodayView } from "./views/TodayView";
import { ConfirmCreateModal, ProjectSuggestModal, TextPromptModal, TicketSuggestModal } from "./modals";
import { GANTT_VIEW_TYPE, GanttView } from "./views/GanttView";
import { KANBAN_VIEW_TYPE, KanbanView } from "./views/KanbanView";
import { JOURNAL_CAL_TYPE, JournalCalendarView } from "./views/JournalCalendarView";
import { JOURNAL_BASE_VIEW_TYPE, JournalBaseView } from "./views/JournalBaseView";
import type { Period } from "./journal";
import { PERIOD_UI, identifyNote, findLatestPeriodNote, listPeriodNotes, neighbours, journalLocation, openPeriodNote, periodNotePath } from "./journal";
import { PROJECTS_BASE_TEMPLATE, assignProject, createProject } from "./projects";
import { DASHBOARD_VIEW_TYPE, DashboardView } from "./views/DashboardView";
import { HOME_VIEW_TYPE, HomeView } from "./views/HomeView";
import { promoteParked, allTasks, sortTasks, prefixOf, rootOf, ensureFolder, folderFor, readTask, isOverdue } from "./model";
import { DayPlan, LEGACY_WEEK_HEADINGS, WEEK_MEETINGS, WEEK_ORDER, WEEK_OVERVIEW, WEEK_TASKS, removeSection, upsertSection, weekMeetings, weekOverview, bulletLines, journalPath, journalWants, meetingLines, readJournalSection, sortByStart, setJournalProps, taskLines, toJournalTasks, writeSection } from "./journal";
import { ensureMeetingNote } from "./meetings";
import { calendarEnabled, calendarEvents } from "./calendar";
import { Emitter, addDays, hmToMin, minToHm, parseTitleEstimate as parseTitleEstimateSafe, parseYmd, today } from "./util";
import { WorkdayManager } from "./workday";
import { applyColors, clearColors } from "./colors";
import { BUFFER_SHARE, isLeftover, weekSteps, weekToPlan } from "./weekplan";
import { capacityOf, weekBuckets } from "./views/weekColumn";
import type { DayLog } from "./worktime";

interface PluginData { settings?: Partial<SamayaSettings>; focus?: FocusState | null; workday?: DayLog | null; /** per-day workday start/end set with the timeline lines */ dayWindows?: Record<string, [string, string]>; }
export interface GuideState { step: number; /** the Review step exists (there were unfinished overdue tasks) */ review: boolean; fresh: boolean; /** "shutdown": the one-step end-of-day guide; "week": the guided week plan */ kind: "plan" | "shutdown" | "week"; /** week guide: the monday (ymd) being planned */ week?: string; /** week guide: the Tickets step exists (there are open tickets) */ tickets?: boolean; /** week guide: days shown by the board (5 or 7), for the sidebar */ days?: number; }

const BASE_TEMPLATE = (folder: string) => `filters:
  and:
    - file.inFolder("${folder}")
properties:
  note.planned:
    displayName: Planned
  note.estimate:
    displayName: Estimate (min)
  note.start:
    displayName: Start
views:
  - type: ${DAILY_VIEW_TYPE}
    name: Daily
  - type: ${WEEK_VIEW_TYPE}
    name: Weekly Board
  - type: ${WTL_VIEW_TYPE}
    name: Weekly Timeline
`;

const TICKETS_BASE_TEMPLATE = (folder: string) => `filters:
  and:
    - file.inFolder("${folder}")
    - file.ext == "md"
views:
  - type: ${KANBAN_VIEW_TYPE}
    name: Board
  - type: table
    name: All tickets
    order:
      - file.name
      - title
      - status
      - project
      - assignee
`;

const JOURNAL_BASE_TEMPLATE = (folder: string) => `filters:
  and:
    - file.inFolder("${folder}")
    - file.ext == "md"
views:
  - type: ${JOURNAL_BASE_VIEW_TYPE}
    name: Calendar
  - type: table
    name: All notes
    order:
      - file.name
      - file.mtime
    sort:
      - property: file.name
        direction: DESC
`;

const HOME_BASE_TEMPLATE = `views:
  - type: ${HOME_VIEW_TYPE}
    name: Home
`;

const WEEKLY_BASE_TEMPLATE = (folder: string) => `filters:
  and:
    - file.inFolder("${folder}")
properties:
  note.planned:
    displayName: Planned
  note.estimate:
    displayName: Estimate (min)
  note.start:
    displayName: Start
views:
  - type: ${WEEK_VIEW_TYPE}
    name: Weekly Board
  - type: ${WTL_VIEW_TYPE}
    name: Weekly Timeline
`;

const TASKS_BASE_TEMPLATE = (folder: string) => `filters:
  and:
    - file.inFolder("${folder}")
properties:
  note.planned:
    displayName: Planned
  note.estimate:
    displayName: Estimate (min)
  note.start:
    displayName: Start
views:
  - type: ${BACKLOG_VIEW_TYPE}
    name: Backlog
    filters:
      and:
        - planned.isEmpty()
        - status != "done"
  - type: ${BACKLOG_BUCKETS_VIEW_TYPE}
    name: Backlog by date
  - type: table
    name: All tasks
    order:
      - file.name
      - status
      - planned
      - start
      - estimate
      - actual
    sort:
      - property: planned
        direction: DESC
`;

/** Remove the Backlog / All tasks views (they moved to the Tasks base) from a planner base file. */
function stripTaskViews(txt: string): string {
  const out: string[] = []; let block: string[] = []; let inViews = false;
  const flush = () => { if (!block.length || !/^    name: (Backlog|All tasks)\s*$/m.test(block.join("\n"))) out.push(...block); block = []; };
  for (const line of txt.split("\n")) {
    if (/^views:/.test(line)) { inViews = true; out.push(line); continue; }
    if (inViews && /^  - /.test(line)) { flush(); block.push(line); }
    else if (inViews && block.length && /^\s/.test(line)) block.push(line);
    else { flush(); out.push(line); }
  }
  flush();
  return out.join("\n");
}

export default class SamayaPlugin extends Plugin {
  settings!: SamayaSettings;
  data: PluginData = {};
  ics = new IcsClient(() => this.settings);
  focus = new FocusManager(this);
  workday = new WorkdayManager(this);
  /** fires when workday / guide state changes so views can refresh */
  bus = new Emitter();
  /** fires when the sidebar should re-evaluate which mode to show (planner open or not) */
  modeBus = new Emitter();
  /** date currently shown by the Daily Planner (used by the sidebar lists) */
  plannerDate = "";
  /** week (monday, ymd) shown by the Weekly Board while it is open ("" = none) */
  boardWeek = "";
  guide: GuideState | null = null;

  async onload() {
    this.data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrateSettings(this.data.settings ?? {}));
    applyColors(this.settings);
    this.registerView(DASHBOARD_VIEW_TYPE, leaf => new DashboardView(leaf, this));
    this.registerView(TODAY_VIEW_TYPE, leaf => new TodayView(leaf, this));
    this.registerView(JOURNAL_CAL_TYPE, leaf => new JournalCalendarView(leaf, this));
    this.registerView(FOCUS_VIEW_TYPE, leaf => new FocusView(leaf, this));
    this.addSettingTab(new SamayaSettingTab(this.app, this));

    const ok = (id: string, name: string, icon: string, factory: Parameters<Plugin["registerBasesView"]>[1]["factory"], options: Parameters<Plugin["registerBasesView"]>[1]["options"]) =>
      this.registerBasesView(id, { name, icon, factory, options });
    const a = ok(DAILY_VIEW_TYPE, "Daily", "lucide-calendar-clock",
      (c, el) => new DailyPlannerView(c, el, this),
      () => [
        { type: "toggle", key: "showIcs", displayName: "Count calendar events as busy", default: true },
      ]);
    const b = ok(WEEK_VIEW_TYPE, "Weekly Board", "lucide-columns-3",
      (c, el) => new WeeklyBoardView(c, el, this),
      () => [{ type: "toggle", key: "showWeekends", displayName: "Show weekends", default: false }]);
    const d = ok(WTL_VIEW_TYPE, "Weekly Timeline", "lucide-calendar-range",
      (c, el) => new WeeklyTimelineView(c, el, this),
      () => [
        { type: "slider", key: "dayStart", displayName: "Day starts (hour)", min: 0, max: 23, step: 1, default: this.settings.dayStartHour },
        { type: "slider", key: "dayEnd", displayName: "Day ends (hour)", min: 1, max: 24, step: 1, default: this.settings.dayEndHour },
        { type: "toggle", key: "showWeekends", displayName: "Show weekends", default: false },
        { type: "toggle", key: "showIcs", displayName: "Show calendar events", default: true },
      ]);
    const c = ok(BACKLOG_VIEW_TYPE, "Backlog", "lucide-inbox",
      (ct, el) => new BacklogView(ct, el, this),
      () => [{ type: "toggle", key: "hideEmptyTickets", displayName: "Hide tickets without tasks", default: false }]);
    const e = ok(GANTT_VIEW_TYPE, "Gantt", "lucide-gantt-chart",
      (ct, el) => new GanttView(ct, el, this),
      () => [{ type: "slider", key: "dayWidth", displayName: "Day width (px)", min: 8, max: 48, step: 2, default: 22 }]);
    const f = ok(KANBAN_VIEW_TYPE, "Ticket board", "lucide-kanban",
      (ct, el) => new KanbanView(ct, el, this),
      () => [{ type: "toggle", key: "hideDone", displayName: "Hide done / closed tickets", default: false }]);
    const bb = ok(BACKLOG_BUCKETS_VIEW_TYPE, "Backlog by date", "lucide-calendar-clock",
      (ct, el) => new BacklogBucketsView(ct, el, this),
      () => [{ type: "toggle", key: "onlyWithTicket", displayName: "Only tasks with a ticket", default: false }]);
    if (!bb) new Notice("Samaya: could not register the Backlog by date view.");
    const g = ok(JOURNAL_BASE_VIEW_TYPE, "Journal calendar", "lucide-calendar",
      (ct, el) => new JournalBaseView(ct, el, this), () => []);
    const h = ok(HOME_VIEW_TYPE, "Home", "lucide-home",
      (ct, el) => new HomeView(ct, el, this), () => []);
    if (!a || !b || !c || !d || !e || !f || !g || !h) new Notice("Samaya: could not register Bases views. Enable the core Bases plugin and use Obsidian 1.10+.");

    this.addRibbonIcon("calendar-clock", "Open Samaya planner", () => { void this.openPlanner(); });
    this.focus.init(this.addStatusBarItem(), this.data.focus ?? null);
    this.workday.init(this.addStatusBarItem(), this.data.workday ?? null);

    this.addRibbonIcon("calendar-days", "Samaya: today's timeline", () => { void this.openToday(); });
    this.addCommand({ id: "open-today", name: "Open today's timeline in the right sidebar", callback: () => this.openToday() });
    this.addCommand({ id: "open-home", name: "Open home", checkCallback: c => { if (!this.settings.homeOn) return false; if (!c) void this.openHome(); return true; } });
    this.addCommand({ id: "plan-week", name: "Plan my week (guided)", callback: () => this.startWeekGuide() });
    this.addCommand({ id: "open-week-board", name: "Open weekly board", callback: () => this.openWeekPlanner() });
    this.addCommand({ id: "review-week", name: "Review my week", callback: () => this.reviewWeek() });
    this.addCommand({ id: "open-planner", name: "Open planner", callback: () => this.openPlanner() });
    this.addCommand({ id: "plan-day", name: "Plan my day (guided)", callback: () => this.startGuide() });
    this.addCommand({ id: "start-day", name: "Start workday now", callback: () => this.workday.startDay() });
    this.addCommand({ id: "start-break", name: "Start break", callback: () => this.workday.startBreak() });
    this.addCommand({ id: "end-break", name: "End break (back to work)", callback: () => this.workday.endBreak() });
    this.addCommand({ id: "dashboard", name: "Open work time dashboard", callback: () => this.openDashboard() });
    this.addCommand({ id: "shutdown", name: "Start shutdown ritual", callback: () => this.startShutdown() });
    this.addCommand({ id: "new-task", name: "New task", callback: () => this.quickAdd() });
    this.addCommand({ id: "focus-current", name: "Focus on current note's task", checkCallback: c => {
      const f = this.app.workspace.getActiveFile(); const ok2 = !!f && f.path.startsWith(prefixOf(this.settings.tasksPath));
      if (ok2 && !c && f) void this.focus.start(f); return ok2;
    } });
    this.addCommand({ id: "focus-show", name: "Show focus timer", callback: () => { void this.focus.openView(); } });
    this.addCommand({ id: "convert-checkbox", name: "Convert checkbox line to task note", editorCallback: (ed, v) => this.convertCheckbox(ed, v as MarkdownView) });
    // sync commands only show while their module is switched on
    const gated = (id: string, name: string, on: () => boolean, only?: "jira" | "gitlab") =>
      this.addCommand({ id, name, checkCallback: c => { if (!on()) return false; if (!c) void this.syncTickets(only); return true; } });
    gated("sync-tickets", "Sync Jira and GitLab tickets", () => this.settings.jiraOn || this.settings.gitlabOn);
    gated("sync-jira", "Sync Jira tickets", () => this.settings.jiraOn, "jira");
    gated("sync-gitlab", "Sync GitLab issues", () => this.settings.gitlabOn, "gitlab");
    this.addCommand({ id: "assign-ticket", name: "Assign current task note to a ticket", checkCallback: c => {
      const f = this.app.workspace.getActiveFile(); const ok2 = !!f && f.path.startsWith(prefixOf(this.settings.tasksPath));
      if (ok2 && !c && f) new TicketSuggestModal(this, t => { void assignTicket(this.app, f, t); }).open(); return ok2;
    } });
    // project commands only show while the module is switched on
    this.addCommand({ id: "new-project", name: "New project", checkCallback: c => {
      if (!this.settings.projectsOn) return false;
      if (!c) new TextPromptModal(this, "New project name", n => { void createProject(this.app, this.settings, n).then(() => this.bus.emit()); }).open();
      return true;
    } });
    this.addCommand({ id: "open-tickets", name: "Open ticket board", checkCallback: c => {
      if (!this.settings.jiraOn && !this.settings.gitlabOn) return false;
      if (!c) void this.scaffoldTickets(false).then(() => { const r = rootOf(this.settings.ticketsPath); const f = this.app.vault.getAbstractFileByPath(normalizePath(r === "/" ? "Tickets.base" : `${r}/Tickets.base`)); if (f instanceof TFile) return this.app.workspace.getLeaf("tab").openFile(f); });
      return true;
    } });
    this.addCommand({ id: "open-journal", name: "Open journal calendar", checkCallback: c => { if (!this.settings.journalOn) return false; if (!c) void this.openJournalCalendar(); return true; } });
    this.addCommand({ id: "open-projects", name: "Open projects", checkCallback: c => { if (!this.settings.projectsOn) return false; if (!c) void this.openProjects(); return true; } });
    this.addCommand({ id: "assign-project", name: "Assign current task or ticket note to a project", checkCallback: c => {
      const f = this.app.workspace.getActiveFile();
      const ok2 = this.settings.projectsOn && !!f && (f.path.startsWith(prefixOf(this.settings.tasksPath)) || f.path.startsWith(prefixOf(this.settings.ticketsPath)));
      if (ok2 && !c && f) new ProjectSuggestModal(this, p => { void assignProject(this.app, f, p); }).open(); return ok2;
    } });
    this.addCommand({ id: "scaffold", name: "Create planner files", callback: () => this.scaffold(true) });

    // journal notes get a class that hides their properties block (styles.css)
    const marks = () => { void this.markJournalNotes(); };
    this.registerEvent(this.app.workspace.on("file-open", marks)); this.registerEvent(this.app.workspace.on("layout-change", marks)); this.registerEvent(this.app.workspace.on("active-leaf-change", marks));
    this.register(this.bus.on(marks));
    this.registerEvent(this.app.metadataCache.on("changed", f => { if (this.indexLunch(f)) this.bus.emit(); void this.fileByPlanned(f); }));
    const ref = this.app.metadataCache.on("resolved", () => { this.scanLunch(); void this.fileAllByPlanned(); this.app.metadataCache.offref(ref); });
    this.app.workspace.onLayoutReady(async () => {
      this.scanLunch();
      void this.markJournalNotes();
      await this.scaffold(false);
      if (this.settings.syncOnStartup && (this.settings.jiraOn || this.settings.gitlabOn)) void this.syncTickets();
      if (this.settings.openOnStartup) await this.openPlanner();
      if (this.settings.homeOn && this.settings.homeOnStartup) await this.openHome();
      this.registerInterval(window.setInterval(() => this.shutdownNudge(), 60000));
      const promote = () => { void promoteParked(this.app, this.settings); };
      promote(); this.registerInterval(window.setInterval(promote, 10 * 60000)); // parked backlog tasks reaching their date move to this week
      void this.meetingSyncLoop();
    });
  }

  /** Fetch the calendar and create/update meeting notes now, then again after every refresh interval (the setting may change meanwhile). */
  private async meetingSyncLoop() {
    try { if ((await syncMeetingNotes(this)) > 0) this.bus.emit(); } catch (e) { console.warn("Samaya: meeting sync failed", e); }
    const t = window.setTimeout(() => { void this.meetingSyncLoop(); }, Math.max(1, this.settings.icsRefreshMinutes) * 60000);
    this.register(() => window.clearTimeout(t));
  }

  /** Keep task notes in the tasks-path subfolder of their scheduled (planned) date; unscheduled ones go to "Unscheduled". */
  async fileByPlanned(f: TFile) {
    const root = rootOf(this.settings.tasksPath); // never reshuffle a whole vault
    if (root === "/" || f.extension !== "md" || !f.path.startsWith(root + "/")) return;
    const { planned } = readTask(this.app, f);
    const [y, m, d] = planned.split("-").map(Number);
    const folder = planned ? folderFor(this.settings.tasksPath, new Date(y, m - 1, d)) : normalizePath(`${root}/Unscheduled`);
    const dir = f.parent?.path ?? "/";
    if (normalizePath(dir) === folder) return;
    let path = `${folder}/${f.name}`; let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${f.basename} ${i++}.${f.extension}`;
    await ensureFolder(this.app, folder);
    await this.app.fileManager.renameFile(f, path);
  }
  async fileAllByPlanned() { for (const f of [...this.app.vault.getMarkdownFiles()]) await this.fileByPlanned(f); }

  private nudged = "";
  private shutdownNudge() {
    const now = new Date(); const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const t = minToHm(this.workWindowFor(today())[1]);
    if (hm === t && this.nudged !== today()) { this.nudged = today(); new Notice("Samaya: time to shut down. Run “Start shutdown ritual”.", 10000); }
  }

  // ---- per-day lunch: stored as the `lunch` property ("12:30-13:30") of that day's daily note
  private lunchIdx = new Map<string, { date: string; range: [string, string] }>(); // note path -> override

  /** Lunch window for a date: the daily note's `lunch` property if set, else the default from the settings. */
  lunchFor(date: string): [number, number] {
    for (const v of this.lunchIdx.values()) if (v.date === date) return [hmToMin(v.range[0]), hmToMin(v.range[1])];
    return [hmToMin(this.settings.lunchStart), hmToMin(this.settings.lunchEnd)];
  }
  private indexLunch(f: TFile): boolean {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    const m = fm && fm.date ? String(fm.lunch ?? "").match(/^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/) : null;
    const before = this.lunchIdx.get(f.path)?.range.join("-");
    if (m) this.lunchIdx.set(f.path, { date: String(fm!.date).slice(0, 10), range: [m[1], m[2]] }); else this.lunchIdx.delete(f.path);
    return before !== (m ? `${m[1]}-${m[2]}` : undefined);
  }
  private scanLunch() { let ch = false; for (const f of this.app.vault.getMarkdownFiles()) ch = this.indexLunch(f) || ch; if (ch) this.bus.emit(); }
  /** Set the lunch for ONE day and write it to that day's daily note (when the journal keeps break times) (null = the current default). */
  async setLunch(date: string, start: string | null, end: string | null) {
    const st = start ?? this.settings.lunchStart, en = end ?? this.settings.lunchEnd;
    if (!journalWants(this.settings, "journalBreaks")) { // no daily note to keep it in: applies until Obsidian restarts
      this.lunchIdx.set("memory:" + date, { date, range: [st, en] }); this.bus.emit(); return;
    }
    const path = await journalPath(this.app, this.settings, date);
    this.lunchIdx.set(path, { date, range: [st, en] }); // optimistic
    this.bus.emit();
    await setJournalProps(this.app, this.settings, date, { date, lunch: `${st}-${en}` });
  }

  // ---- per-day workday window (start/end lines of the timeline): kept in data.json, the settings are the default
  /** Workday [start, end] in minutes for a date: the day's own lines if moved, else the default from the settings. */
  workWindowFor(date: string): [number, number] {
    const w = this.data.dayWindows?.[date] ?? [this.settings.dayStartTime, this.settings.shutdownTime];
    return [hmToMin(w[0]), hmToMin(w[1])];
  }
  /** Set the workday window of ONE day (null = back to the default). */
  async setWorkWindow(date: string, w: [string, string] | null) {
    const all = this.data.dayWindows ?? (this.data.dayWindows = {});
    if (w) all[date] = w; else delete all[date];
    await this.saveData(this.data); this.bus.emit();
  }

  onunload() { clearColors(); }

  async saveSettings() { this.data.settings = this.settings; applyColors(this.settings); await this.saveData(this.data); }

  syncTickets(only?: "jira" | "gitlab") { return syncTickets(this, only); }

  /** Projects folder and its base (only when the module is on). */
  async scaffoldProjects(announce: boolean) {
    const s = this.settings; if (!s.projectsOn) return;
    const folder = normalizePath(s.projectsPath.trim() || "Projects"); await ensureFolder(this.app, folder);
    const bp = normalizePath(s.projectsBase.trim() || `${folder}/Projects.base`);
    if (this.app.vault.getAbstractFileByPath(bp)) { if (announce) new Notice("Projects base already exists."); return; }
    const dir = bp.split("/").slice(0, -1).join("/"); if (dir) await ensureFolder(this.app, dir);
    await this.app.vault.create(bp, PROJECTS_BASE_TEMPLATE(folder, GANTT_VIEW_TYPE));
    if (announce) new Notice("Created " + bp);
  }
  /** Vault path of the home page (".base" added when missing). */
  homeFile(path = this.settings.homePath): string { const p = normalizePath(path.trim() || "Home.base"); return p.endsWith(".base") ? p : p + ".base"; }
  /** The home page base at the configured path (only when the module is on). */
  async scaffoldHome(announce: boolean) {
    if (!this.settings.homeOn) return;
    const hp = this.homeFile();
    if (this.app.vault.getAbstractFileByPath(hp)) { if (announce) new Notice("Home page already exists."); return; }
    const dir = hp.split("/").slice(0, -1).join("/"); if (dir) await ensureFolder(this.app, dir);
    await this.app.vault.create(hp, HOME_BASE_TEMPLATE); if (announce) new Notice("Created " + hp);
  }
  /** The home path changed: move the existing page along, or create one at the new path. */
  async moveHome(from: string, to: string) {
    const src = this.app.vault.getAbstractFileByPath(this.homeFile(from)); const dst = this.homeFile(to);
    if (src instanceof TFile && !this.app.vault.getAbstractFileByPath(dst)) {
      const dir = dst.split("/").slice(0, -1).join("/"); if (dir) await ensureFolder(this.app, dir);
      await this.app.fileManager.renameFile(src, dst); new Notice("Moved the home page to " + dst);
    } else await this.scaffoldHome(true);
  }
  async openHome() {
    await this.scaffoldHome(false);
    const f = this.app.vault.getAbstractFileByPath(this.homeFile());
    if (!(f instanceof TFile)) return;
    let found: import("obsidian").WorkspaceLeaf | null = null;
    this.app.workspace.iterateRootLeaves(l => { if (!found && (l.view as { file?: TFile }).file?.path === f.path) found = l; });
    const leaf = found ?? this.app.workspace.getLeaf("tab");
    if (!found) await leaf.openFile(f);
    await this.app.workspace.revealLeaf(leaf);
  }
  /** Weekly Board + Weekly Timeline in their own base next to the planner (the planner base always opens on the Daily Planner). */
  async openWeekPlanner() {
    const dir = normalizePath(this.settings.plannerFile).split("/").slice(0, -1).join("/");
    const wp = normalizePath(dir ? `${dir}/Weekly.base` : "Weekly.base");
    if (!this.app.vault.getAbstractFileByPath(wp)) {
      if (dir) await ensureFolder(this.app, dir);
      const root = rootOf(this.settings.tasksPath); await ensureFolder(this.app, root === "/" ? "" : root);
      await this.app.vault.create(wp, WEEKLY_BASE_TEMPLATE(root));
    }
    const f = this.app.vault.getAbstractFileByPath(wp); if (!(f instanceof TFile)) return;
    let found: import("obsidian").WorkspaceLeaf | null = null;
    this.app.workspace.iterateRootLeaves(l => { if (!found && (l.view as { file?: TFile }).file?.path === f.path) found = l; });
    const leaf = found ?? this.app.workspace.getLeaf("tab");
    if (!found) await leaf.openFile(f);
    await this.app.workspace.revealLeaf(leaf);
  }
  /** Weekly note when the journal keeps them, else the work time dashboard. */
  async reviewWeek() {
    const s = this.settings;
    if (s.journalOn && s.journalNotes.weekly.on) {
      const f = await openPeriodNote(this.app, s, "weekly", today());
      if (f) { await this.openNoteInMain(f); return; }
    }
    await this.openDashboard();
  }

  /** Tickets/Tickets.base: a kanban board of the imported tickets (only while Jira or GitLab is on). */
  async scaffoldTickets(announce: boolean) {
    if (!this.settings.jiraOn && !this.settings.gitlabOn) return;
    const folder = rootOf(this.settings.ticketsPath);
    if (folder !== "/") await ensureFolder(this.app, folder);
    const bp = normalizePath(folder === "/" ? "Tickets.base" : `${folder}/Tickets.base`);
    if (this.app.vault.getAbstractFileByPath(bp)) { if (announce) new Notice("Tickets base already exists."); return; }
    await this.app.vault.create(bp, TICKETS_BASE_TEMPLATE(folder)); if (announce) new Notice("Created " + bp);
  }
  /** Journal/Journal.base: opens the calendar sidebar (only while the journal is on). */
  async scaffoldJournal(announce: boolean) {
    if (!this.settings.journalOn) return;
    const loc = await journalLocation(this.app, this.settings);
    const root = loc.pattern ? rootOf(loc.folder) : normalizePath(loc.folder || "/");
    const bp = "Journal/Journal.base";
    if (this.app.vault.getAbstractFileByPath(bp)) { if (announce) new Notice("Journal base already exists."); return; }
    await ensureFolder(this.app, "Journal");
    await this.app.vault.create(bp, JOURNAL_BASE_TEMPLATE(root === "/" ? "Journal" : root)); if (announce) new Notice("Created " + bp);
  }
  private marking = false; private markAgain = false;
  /** Per open note tab: mark journal notes with `samaya-journal-note` (hides their title and properties, styles.css) and show / remove the navigation bar. Runs one at a time. */
  async markJournalNotes() {
    if (this.marking) { this.markAgain = true; return; }
    this.marking = true;
    try {
      do {
        this.markAgain = false;
        const s = this.settings;
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
          const file = (leaf.view as { file?: TFile }).file; const el = leaf.view.containerEl;
          const id = s.journalOn && !!file ? await identifyNote(this.app, s, file) : null;
          el.toggleClass("samaya-journal-note", s.journalHideProps && !!id);
          await this.renderJournalBar(el, s.journalNavBar && file && id ? { file, ...id } : null);
        }
      } while (this.markAgain);
    } finally { this.marking = false; }
  }
  private async renderJournalBar(el: HTMLElement, cur: { file: TFile; p: Period; date: string } | null) {
    const bars = () => Array.from(el.querySelectorAll<HTMLElement>(":scope > .samaya-journal-bar"));
    if (!cur) { bars().forEach(b => b.remove()); return; }
    const s = this.settings; const ui = PERIOD_UI[cur.p];
    const { prev, next } = neighbours(await listPeriodNotes(this.app, s, cur.p), cur.date);
    const nowNote = await periodNotePath(this.app, s, cur.p, today());
    const isNow = nowNote?.path === cur.file.path;
    const key = JSON.stringify([cur.file.path, cur.p, cur.date, prev?.file.path, next?.file.path, isNow]);
    const existing = bars(); // no await below: check, clean up and insert in one go
    if (existing.length === 1 && existing[0].dataset.key === key) return;
    existing.forEach(b => b.remove());
    const content = el.querySelector(":scope > .view-content"); if (!content) return;
    const bar = createDiv({ cls: "samaya-journal-bar" }); bar.dataset.key = key;
    const open = (f: TFile | null) => { if (f) void this.openNoteInMain(f); };
    const nav = bar.createDiv({ cls: "samaya-jb-nav" });
    const arrow = (icon: string, dir: string, target: { file: TFile } | null) => {
      const b = nav.createEl("button", { cls: "samaya-jb-arrow", attr: { "aria-label": target ? `${dir} ${ui.noun}: ${target.file.basename}` : `No ${dir} ${ui.noun}` } });
      setIcon(b, icon); if (target) b.addEventListener("click", () => open(target.file)); else b.disabled = true;
    };
    arrow("chevron-left", "Previous", prev);
    nav.createSpan({ cls: "samaya-jb-title", text: momentFmt(new Date(cur.date + "T12:00:00"), ui.title) });
    arrow("chevron-right", "Next", next);
    const now = bar.createEl("button", { cls: "samaya-jb-now", text: ui.now, attr: { "aria-label": `Go to ${ui.now.toLowerCase()}` } });
    if (isNow) now.disabled = true; else now.addEventListener("click", () => { void openPeriodNote(this.app, s, cur.p, today()).then(open); });
    el.insertBefore(bar, content);
  }
  /** Open a note in the main area: reuse a tab already showing it, else the first note tab, else a new tab. */
  async openNoteInMain(file: TFile) {
    let same: import("obsidian").WorkspaceLeaf | null = null, note: import("obsidian").WorkspaceLeaf | null = null;
    this.app.workspace.iterateRootLeaves(l => {
      if ((l.view as { file?: TFile }).file?.path === file.path) same = l;
      else if (!note && l.view.getViewType() === "markdown") note = l;
    });
    const leaf = same ?? note ?? this.app.workspace.getLeaf("tab");
    if (!same) await (leaf as import("obsidian").WorkspaceLeaf).openFile(file);
    await this.app.workspace.revealLeaf(leaf as import("obsidian").WorkspaceLeaf);
  }
  /** When the Journal base opens: the calendar, plus today's daily note, else the latest daily, else the latest weekly note, else ask to create today's. */
  async openJournalDefault() {
    const s = this.settings; if (!s.journalOn) return;
    await this.openJournalCalendar();
    const daily = await periodNotePath(this.app, s, "daily", today()); if (!daily) return;
    const file = daily.file ?? await findLatestPeriodNote(this.app, s, "daily") ?? await findLatestPeriodNote(this.app, s, "weekly");
    if (file) { await this.openNoteInMain(file); return; }
    new ConfirmCreateModal(this, daily.path, () => { void openPeriodNote(this.app, s, "daily", today()).then(f => { if (f) return this.openNoteInMain(f); }); }, "No daily or weekly notes exist yet.").open();
  }
  async openJournalCalendar() {
    const ws = this.app.workspace; let leaf = ws.getLeavesOfType(JOURNAL_CAL_TYPE)[0];
    if (!leaf) { leaf = ws.getRightLeaf(false) ?? ws.getLeaf("split", "vertical"); await leaf.setViewState({ type: JOURNAL_CAL_TYPE, active: true }); }
    await ws.revealLeaf(leaf);
  }
  async openProjects() {
    await this.scaffoldProjects(false);
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.projectsBase.trim() || "Projects/Projects.base"));
    if (f instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(f);
  }

  async scaffold(announce: boolean) {
    await this.scaffoldProjects(announce); await this.scaffoldTickets(announce); await this.scaffoldJournal(announce); await this.scaffoldHome(false);
    const folder = rootOf(this.settings.tasksPath);
    if (folder !== "/") await ensureFolder(this.app, folder);
    // Daily notes follow the core plugin; only seed its config when it has none
    const dn = normalizePath(`${this.app.vault.configDir}/daily-notes.json`);
    try {
      if (this.settings.journalOn && !(await this.app.vault.adapter.exists(dn))) await this.app.vault.adapter.write(dn, JSON.stringify({ folder: rootOf(this.settings.journalFolder).replace(/^\/$/, ""), format: "YYYY-MM-DD" }, null, 2));
    } catch (e) { console.warn("Samaya: could not seed daily-notes.json", e); }

    // Backlog + All tasks live in their own base inside the tasks folder; moved out of the planner base once
    const tp = normalizePath(folder === "/" ? "Tasks.base" : `${folder}/Tasks.base`);
    const tasksBaseFile = this.app.vault.getAbstractFileByPath(tp);
    const tasksBaseNew = !tasksBaseFile;
    if (tasksBaseFile instanceof TFile) {
      // older Tasks.base files get the Backlog by date view added once
      const txt = await this.app.vault.read(tasksBaseFile);
      if (!txt.includes(BACKLOG_BUCKETS_VIEW_TYPE) && /^views:/m.test(txt)) {
        const next = /^  - type: table\n    name: All tasks/m.test(txt) ? txt.replace(/^(  - type: table\n    name: All tasks)/m, `  - type: ${BACKLOG_BUCKETS_VIEW_TYPE}\n    name: Backlog by date\n$1`) : txt.replace(/\n*$/, "\n") + `  - type: ${BACKLOG_BUCKETS_VIEW_TYPE}\n    name: Backlog by date\n`;
        await this.app.vault.modify(tasksBaseFile, next); new Notice("Samaya: added the Backlog by date view to " + tp);
      }
    }
    if (tasksBaseNew) { await this.app.vault.create(tp, TASKS_BASE_TEMPLATE(folder)); if (announce) new Notice("Created " + tp); }

    const bp = normalizePath(this.settings.plannerFile);
    const bf = this.app.vault.getAbstractFileByPath(bp);
    if (!bf) { const dir = bp.split("/").slice(0, -1).join("/"); if (dir) await ensureFolder(this.app, dir); await this.app.vault.create(bp, BASE_TEMPLATE(folder)); if (announce) new Notice("Created " + bp); }
    else if (bf instanceof TFile) {
      let txt = await this.app.vault.read(bf);
      if (/file\.folder == "/.test(txt)) { txt = txt.replace(/file\.folder == "([^"]*)"/, 'file.inFolder("$1")'); await this.app.vault.modify(bf, txt); } // tasks now live in year/month subfolders
      if (tasksBaseNew) {
        const next = stripTaskViews(txt);
        if (next !== txt) { await this.app.vault.modify(bf, next); txt = next; new Notice(`Samaya: moved the Backlog and All tasks views to ${tp}`); }
      } else if (announce) new Notice("Planner files already exist.");
      if (/^    name: Daily Planner\s*$/m.test(txt)) { txt = txt.replace(/^(    name: )Daily Planner(\s*)$/m, "$1Daily$2"); await this.app.vault.modify(bf, txt); }
      if (!txt.includes(WTL_VIEW_TYPE)) {
        const next = txt.replace(new RegExp(`(  - type: ${WEEK_VIEW_TYPE}\\n    name: [^\\n]*\\n)`), `$1  - type: ${WTL_VIEW_TYPE}\n    name: Weekly Timeline\n`);
        if (next !== txt) { await this.app.vault.modify(bf, next); new Notice("Samaya: added the Weekly Timeline view to " + bp); }
      }
    }
  }

  /** Open (or focus) the planner in the MAIN area, even when called from a sidebar. */
  async openPlanner() {
    await this.scaffold(false);
    const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.plannerFile));
    if (!(f instanceof TFile)) return;
    const ws = this.app.workspace; let found: import("obsidian").WorkspaceLeaf | null = null;
    ws.iterateRootLeaves(l => { if (!found && (l.view as { file?: TFile }).file?.path === f.path) found = l; });
    const leaf = found ?? ws.getLeaf("tab");
    if (!found) await leaf.openFile(f);
    await ws.revealLeaf(leaf);
    await this.openToday(); // the timeline lives in the sidebar while the planner is open
    ws.setActiveLeaf(leaf, { focus: true });
  }
  async openToday() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(TODAY_VIEW_TYPE)[0];
    if (!leaf) { leaf = ws.getRightLeaf(false) ?? ws.getLeaf("split", "vertical"); await leaf.setViewState({ type: TODAY_VIEW_TYPE, active: true }); }
    await ws.revealLeaf(leaf);
  }
  async openDashboard() {
    const ws = this.app.workspace; let leaf = ws.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (!leaf) { leaf = ws.getLeaf("tab"); await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true }); }
    await ws.revealLeaf(leaf);
  }
  /** Interactive planning: opens the daily planner and walks through it (see views/guide.ts). */
  private leftCollapsedByGuide = false;
  /** Leaves the guide and brings the left sidebar back if the guide hid it. */
  /** the right sidebar was closed when the week guide opened it: close it again afterwards */
  private rightOpenedByGuide = false;
  closeGuide() {
    this.guide = null;
    if (this.leftCollapsedByGuide) { this.leftCollapsedByGuide = false; this.app.workspace.leftSplit?.expand(); }
    if (this.rightOpenedByGuide) { this.rightOpenedByGuide = false; this.app.workspace.rightSplit?.collapse(); }
    this.modeBus.emit();
    this.bus.emit();
  }
  /** Interactive week plan: Review, Tickets, Backlog, Schedule, Check (see views/guide.ts and WeeklyBoardView). The left sidebar makes room, the right one shows This week. */
  async startWeekGuide() {
    const ws = this.app.workspace; const now = new Date(); const wk = weekToPlan(today(), now.getDay());
    const leftover = allTasks(this.app, this.settings).some(t => isLeftover(t, today(), wk));
    const tickets = allTickets(this.app, this.settings).some(t => !/(done|closed|resolved|complete|finished|released|cancel)/i.test(t.state));
    this.guide = { step: weekSteps(leftover, tickets)[0], review: leftover, fresh: true, kind: "week", week: wk, tickets };
    await this.openWeekPlanner();
    if (ws.leftSplit && !ws.leftSplit.collapsed) { ws.leftSplit.collapse(); this.leftCollapsedByGuide = true; }
    if (ws.rightSplit?.collapsed) this.rightOpenedByGuide = true;
    await this.openToday(); // opens the right sidebar: it shows This week while the guide runs
    this.bus.emit();
  }
  async finishWeekGuide() {
    const g = this.guide; const wk = g?.week; const days = g?.days ?? 5;
    this.closeGuide();
    if (!wk) return;
    let saved = false;
    try { saved = await this.writeWeekPlan(wk, days); } catch (e) { console.error("Samaya: could not write the weekly note", e); new Notice("Samaya: could not write the weekly note (see the console)."); }
    new Notice(`Week of ${parseYmd(wk).toLocaleDateString(undefined, { month: "short", day: "numeric" })} planned${saved ? " and saved to your weekly note" : ""}. Leave room for the unexpected.`);
  }
  /** The weekly note (created if missing) gets an "Overview", the week's "Meetings" by weekday and its "Planned tasks". False when nothing is written. */
  private async writeWeekPlan(wk: string, nDays: number): Promise<boolean> {
    const s = this.settings; const wantPlan = journalWants(s, "journalWeekPlan"), wantMeet = journalWants(s, "journalWeekMeetings"), wantTasks = journalWants(s, "journalWeekTasks");
    if (!s.journalNotes.weekly.on || !(wantPlan || wantMeet || wantTasks)) return false;
    const file = await openPeriodNote(this.app, s, "weekly", wk); if (!file) return false;
    const { weekTasks, noDay } = weekBuckets(allTasks(this.app, s), wk);
    const events = calendarEnabled(s) ? await calendarEvents(this, parseYmd(wk), parseYmd(addDays(wk, 7))).catch(() => []) : [];
    const dates = Array.from({ length: nDays }, (_, i) => addDays(wk, i));
    const plans: DayPlan[] = [];
    for (const d of dates) { // one after the other: the meeting notes are created on the way
      const t0 = parseYmd(d).getTime(), t1 = parseYmd(addDays(d, 1)).getTime(); const cap = capacityOf(this, d, events);
      const weekday = parseYmd(d).toLocaleDateString(undefined, { weekday: "long" });
      const tasks = sortByStart(sortTasks(weekTasks.filter(t => t.planned === d)));
      const dayEvents = events.filter(e => e.end.getTime() > t0 && e.start.getTime() < t1).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
      plans.push({ weekday, label: parseYmd(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }), note: (await journalPath(this.app, s, d)).split("/").pop()!.replace(/\.md$/, ""),
        planned: tasks.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0), meetings: cap.meetings, free: cap.free,
        tasks: (await toJournalTasks(this.app, tasks, false, true)).map(t => ({ ...t, day: weekday })),
        events: wantMeet ? await Promise.all(dayEvents.map(async e => ({ ...e, note: e.allDay ? undefined : await ensureMeetingNote(this.app, s, e, dayEvents).then(f => f.basename, () => undefined) }))) : dayEvents });
    }
    const unscheduled = (await toJournalTasks(this.app, noDay)).map(t => ({ ...t, day: "no day" }));
    await this.app.vault.process(file, t => {
      let x = t; for (const h of [...LEGACY_WEEK_HEADINGS, ...plans.map(p => p.label)]) x = removeSection(x, h); // sections written by earlier versions
      if (wantPlan) x = upsertSection(x, WEEK_OVERVIEW, weekOverview(plans, noDay.length), WEEK_ORDER);
      if (wantMeet) x = upsertSection(x, WEEK_MEETINGS, weekMeetings(plans), WEEK_ORDER);
      if (wantTasks) x = upsertSection(x, WEEK_TASKS, taskLines([...unscheduled, ...plans.flatMap(p => p.tasks)]), WEEK_ORDER);
      return x;
    });
    return true;
  }



  async startGuide() {
    const ls = this.app.workspace.leftSplit;
    if (ls && !ls.collapsed) { ls.collapse(); this.leftCollapsedByGuide = true; } // room for the planner while planning
    const overdue = allTasks(this.app, this.settings).some(isOverdue);
    this.guide = { step: overdue ? 0 : 1, review: overdue, fresh: true, kind: "plan" };
    await this.openPlanner(); this.bus.emit();
  }
  async finishGuide() {
    const g = this.guide; if (!g) return; const s = this.settings; const td = today();
    const day = sortTasks(allTasks(this.app, s).filter(t => t.planned === td));
    if (s.journalOn && calendarEnabled(s)) {
      const from = parseYmd(td); const evs = await calendarEvents(this, from, parseYmd(addDays(td, 1))).catch(() => null);
      if (evs) await writeSection(this.app, s, td, "Meetings", meetingLines(await Promise.all(evs.map(async e => ({ ...e, note: e.allDay ? undefined : await ensureMeetingNote(this.app, s, e, evs).then(f => f.basename, () => undefined) })))));
    }
    if (journalWants(s, "journalPlanned")) await writeSection(this.app, s, td, "Planned tasks", taskLines(await toJournalTasks(this.app, sortByStart(day), false, true)));
    const wasStarted = this.workday.started;
    await this.workday.startDay();
    this.closeGuide();
    new Notice(`Day planned${wasStarted ? "" : " and started"}.${s.journalOn ? " Saved to your journal." : ""}`);
  }
  /** End of day: the planner with a one-step guide (tick off forgotten tasks), then finalize. */
  async startShutdown() {
    const td = today(); const day = allTasks(this.app, this.settings).filter(t => t.planned === td);
    if (day.every(t => t.status === "done")) { await this.finishShutdown(); return; } // nothing left to check off: end the day right away
    this.guide = { step: 0, review: false, fresh: true, kind: "shutdown" };
    await this.openPlanner(); this.bus.emit();
  }
  async finishShutdown() {
    const s = this.settings; const td = today(); const tm = addDays(td, 1);
    const all = allTasks(this.app, s);
    const finished = sortTasks(all.filter(t => t.status === "done" && t.planned === td));
    const tomorrow = sortTasks(all.filter(t => t.planned === tm && t.status !== "done"));
    if (journalWants(s, "journalFinished")) await writeSection(this.app, s, td, "Finished tasks", taskLines(await toJournalTasks(this.app, finished, true)));
    if (journalWants(s, "journalTomorrow")) await writeSection(this.app, s, td, "Planned for tomorrow", taskLines(await toJournalTasks(this.app, tomorrow)));
    await this.workday.endDay();
    this.closeGuide();
    new Notice(`Day ended${s.journalOn ? " - saved to your journal" : ""}. See you tomorrow.`);
  }

  private quickAdd() {
    new TextPromptModal(this, "New task (append 30m / 1h for an estimate)", raw => {
      const p = parseTitleEstimateSafe(raw);
      void createTask(this.app, this.settings, p.title, { planned: today(), estimate: p.estimate ?? this.settings.defaultEstimate });
    }).open();
  }

  private async convertCheckbox(ed: Editor, view: MarkdownView) {
    const line = ed.getCursor().line; const text = ed.getLine(line);
    const m = text.match(/^(\s*)[-*]\s+\[( |x)\]\s+(.+)$/i);
    if (!m) { new Notice("Cursor is not on a checkbox line."); return; }
    const p = parseTitleEstimateSafe(m[3]);
    const src = view.file?.path ?? "";
    const dm = src.match(/(\d{4}-\d{2}-\d{2})/);
    const f = await createTask(this.app, this.settings, p.title, {
      ...(dm ? { planned: dm[1] } : {}), estimate: p.estimate ?? this.settings.defaultEstimate, ...(m[2].toLowerCase() === "x" ? { status: "done" } : {}),
    });
    ed.setLine(line, `${m[1]}- [${m[2]}] [[${f.basename}]]`);
  }
}
