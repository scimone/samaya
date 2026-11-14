import { hooks, openNote, sideLeaf } from "./openfile";
import { renderSideBars } from "./views/sideBar";
import { reviewItems } from "./views/dayReview";
import { reviewSummary } from "./dayreview";
import { Editor, MarkdownView, Notice, Plugin, TFile, addIcon, normalizePath, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, SamayaSettings, SamayaSettingTab, migrateSettings } from "./settings";
import { FocusManager, FocusState } from "./focus";
import { assignTicketLinked, assignProjectLinked } from "./links";
import { Ticket, allTickets, createTask, momentFmt } from "./model";
import { PLANNER_VIEW_TYPE, PlannerView, SAMAYA_ICON, SAMAYA_ICON_SVG } from "./views/PlannerView";
import { syncTickets } from "./sync";
import { TODAY_VIEW_TYPE, TodayView } from "./views/TodayView";
import { ConfirmCreateModal, ProjectSuggestModal, TextPromptModal, TicketSuggestModal } from "./modals";
import type { Period } from "./journal";
import { renderJournalBar } from "./views/journalBar";
import { PERIODIC_KINDS, PERIOD_UI, identifyNote, findLatestPeriodNote, listPeriodNotes, neighbours, journalLocation, openPeriodNote, periodNotePath } from "./journal";
import { affectsTaskLists, syncTaskLists } from "./tasklinks";
import { createProject, projectPathOf } from "./projects";
import { DASHBOARD_VIEW_TYPE, DashboardView } from "./views/DashboardView";
import { promoteParked, allTasks, sortTasks, prefixOf, rootOf, ensureFolder, folderFor, readTask, isOverdue, onDay } from "./model";
import { ConfirmOverwriteModal } from "./modals";
import { renderTaskCard } from "./views/taskCard";
import { DayPlan, LEGACY_WEEK_HEADINGS, readSection, WEEK_MEETINGS, WEEK_ORDER, WEEK_OVERVIEW, WEEK_TASKS, removeSection, upsertSection, weekMeetings, weekOverview, bulletLines, journalPath, journalWants, meetingLines, readJournalSection, sortByStart, setJournalProps, taskLines, toJournalTasks, writeSection } from "./journal";
import { ensureMeetingNote } from "./meetings";
import { MeetingBanner } from "./meetingbanner";
import { calendarEnabled, calendarEvents } from "./calendar";
import { dayPieces } from "./sessions";
import { Emitter, addDays, hmToMin, minToHm, parseTitleEstimate as parseTitleEstimateSafe, parseYmd, today } from "./util";
import { WorkdayManager, nowMin } from "./workday";
import { NavShortcuts } from "./navigation";
import { applyColors, clearColors } from "./colors";
import { BUFFER_SHARE, isLeftover, weekSteps, weekToPlan } from "./weekplan";
import { capacityOf, weekBuckets } from "./views/weekColumn";
import { workedOn, type DayLog, type RulesFor } from "./worktime";

interface PluginData { settings?: Partial<SamayaSettings>; focus?: FocusState | null; workday?: DayLog | null; /** per-day workday start/end set with the timeline lines */ dayWindows?: Record<string, [string, string]>; /** the plan as it was when the day was first planned (date -> task path and estimate), the baseline of the end-of-day review */ dayPlans?: Record<string, Array<{ path: string; est: number; /** its time slots that day: [start minute, length] */ slots?: Array<[number, number]> }>>; }
export interface GuideState { step: number; /** the Review step exists (there were unfinished overdue tasks) */ review: boolean; fresh: boolean; /** "shutdown": the one-step end-of-day guide; "week": the guided week plan */ kind: "plan" | "shutdown" | "week"; /** week guide: the monday (ymd) being planned */ week?: string; /** week guide: the Tickets step exists (there are open tickets) */ tickets?: boolean; /** week guide: days shown by the board (5 or 7), for the sidebar */ days?: number; }


export default class SamayaPlugin extends Plugin {
  settings!: SamayaSettings;
  data: PluginData = {};
  focus = new FocusManager(this);
  meetingBanner = new MeetingBanner(this);
  workday = new WorkdayManager(this);
  nav = new NavShortcuts(this);
  /** fires when workday / guide state changes so views can refresh */
  bus = new Emitter();
  /** fires when the sidebar should re-evaluate which mode to show (planner open or not) */
  modeBus = new Emitter();
  /** date currently shown by the Daily Planner (used by the sidebar lists) */
  plannerDate = "";
  plannerGoTo: ((date: string) => void) | null = null; // set by the visible day planner: the sidebar status column steps through days with it
  /** week (monday, ymd) shown by the Weekly Board while it is open ("" = none) */
  boardWeek = "";
  guide: GuideState | null = null;
  /** week (monday, ymd) the expanded week should open on, once ("" = the day's week) */
  weekToShow = "";
  /** the week timeline is expanded inside the Planner (both sidebars folded away) */
  timelineWide = false;
  /** the work time dashboard is showing inside the Planner (in place of the day / week) */
  workTimeOpen = false;
  showWorkTime() { this.workTimeOpen = true; this.bus.emit(); this.modeBus.emit(); }
  hideWorkTime() { if (!this.workTimeOpen) return; this.workTimeOpen = false; this.bus.emit(); this.modeBus.emit(); }
  /** expanded week: timeline above the task board ("split"), or just one of them */
  weekLayout: "split" | "timeline" | "board" = "split";
  private wideSaved: { left: boolean; right: boolean } | null = null;
  /** Planner: expand the timeline into the week timeline; both sidebars make room. */
  expandTimeline(leftWas = false) {
    if (this.timelineWide) return; const ws = this.app.workspace;
    this.wideSaved = { left: leftWas || (!!ws.leftSplit && !ws.leftSplit.collapsed), right: !!ws.rightSplit && !ws.rightSplit.collapsed };
    ws.leftSplit?.collapse(); ws.rightSplit?.collapse();
    this.timelineWide = true; this.bus.emit();
  }
  /** Back to the day planner, and the sidebars as they were. */
  collapseTimeline(keepSidebars = false): boolean {
    if (!this.timelineWide) return false; const ws = this.app.workspace; const sv = this.wideSaved; this.timelineWide = false; this.wideSaved = null;
    if (keepSidebars) return !!sv?.left; // no redraw here: the caller sets the guide first, so the day view never flashes // a guide follows: the sidebars stay folded (no flicker)
    if (sv?.left) ws.leftSplit?.expand(); if (sv?.right) ws.rightSplit?.expand();
    this.bus.emit(); this.modeBus.emit(); return false;
  }

  async onload() {
    hooks.focusPath = () => this.focus.state?.path; hooks.dress = () => this.dressSide(); // what openfile.ts needs from the plugin
    this.data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrateSettings(this.data.settings ?? {}));
    applyColors(this.settings);
    addIcon(SAMAYA_ICON, SAMAYA_ICON_SVG);
    this.registerView(PLANNER_VIEW_TYPE, leaf => new PlannerView(leaf, this));
    this.registerView(DASHBOARD_VIEW_TYPE, leaf => new DashboardView(leaf, this));
    this.registerView(TODAY_VIEW_TYPE, leaf => new TodayView(leaf));
    this.addSettingTab(new SamayaSettingTab(this.app, this));


    this.addRibbonIcon(SAMAYA_ICON, "Open Samaya", () => { void this.openPlanner(); });
    this.focus.init(this.data.focus ?? null);
    this.meetingBanner.init();
    this.workday.init(this.data.workday ?? null);

    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => { // switching to the planner tab folds the right sidebar away
      if (!leaf || leaf.getRoot() !== this.app.workspace.rootSplit) return;
      if (leaf.view.containerEl.querySelector(".samaya-planner, .samaya-daily")) this.app.workspace.rightSplit?.collapse();
    }));
    this.addCommand({ id: "plan-week", name: "Plan my week (guided)", callback: () => this.startWeekGuide() });
    this.addCommand({ id: "review-week", name: "Review my week", callback: () => this.reviewWeek() });
    this.addCommand({ id: "toggle-week-timeline", name: "Toggle week timeline (expand / collapse)", callback: () => { if (this.timelineWide) this.collapseTimeline(); else { void this.openPlanner().then(() => this.expandTimeline()); } } });
    this.addCommand({ id: "open-planner", name: "Open Samaya", callback: () => this.openPlanner() });
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
    this.addCommand({ id: "convert-checkbox", name: "Convert checkbox line to task note", editorCallback: (ed, v) => this.convertCheckbox(ed, v as MarkdownView) });
    // sync commands only show while their module is switched on
    const gated = (id: string, name: string, on: () => boolean, only?: "jira" | "gitlab") =>
      this.addCommand({ id, name, checkCallback: c => { if (!on()) return false; if (!c) void this.syncTickets(only); return true; } });
    gated("sync-tickets", "Sync Jira and GitLab tickets", () => this.settings.jiraOn || this.settings.gitlabOn);
    gated("sync-jira", "Sync Jira tickets", () => this.settings.jiraOn, "jira");
    gated("sync-gitlab", "Sync GitLab issues", () => this.settings.gitlabOn, "gitlab");
    this.addCommand({ id: "assign-ticket", name: "Assign current task note to a ticket", checkCallback: c => {
      const f = this.app.workspace.getActiveFile(); const ok2 = (this.settings.jiraOn || this.settings.gitlabOn) && !!f && f.path.startsWith(prefixOf(this.settings.tasksPath));
      if (ok2 && !c && f) new TicketSuggestModal(this, t => { void assignTicketLinked(this.app, this.settings, f, t); }).open(); return ok2;
    } });
    // project commands only show while the module is switched on
    this.addCommand({ id: "new-project", name: "New project", checkCallback: c => {
      if (!this.settings.projectsOn) return false;
      if (!c) new TextPromptModal(this, "New project name", n => { void createProject(this.app, this.settings, n).then(() => this.bus.emit()); }).open();
      return true;
    } });
    this.addCommand({ id: "open-tickets", name: "Open ticket board", checkCallback: c => {
      if (!this.settings.jiraOn && !this.settings.gitlabOn) return false;
      if (!c) void this.scaffoldTickets(false).then(() => this.openSection("tickets"));
      return true;
    } });
    this.addCommand({ id: "open-journal", name: "Open journal", checkCallback: c => { if (!this.settings.journalOn) return false; if (!c) void this.openSection("journal"); return true; } });
    this.addCommand({ id: "open-projects", name: "Open projects", checkCallback: c => { if (!this.settings.projectsOn) return false; if (!c) void this.openProjects(); return true; } });
    this.addCommand({ id: "assign-project", name: "Assign current task or ticket note to a project", checkCallback: c => {
      const f = this.app.workspace.getActiveFile();
      const ok2 = this.settings.projectsOn && !!f && (f.path.startsWith(prefixOf(this.settings.tasksPath)) || f.path.startsWith(prefixOf(this.settings.ticketsPath)));
      if (ok2 && !c && f) new ProjectSuggestModal(this, p => { void assignProjectLinked(this.app, this.settings, f, p); }).open(); return ok2;
    } });
    this.addCommand({ id: "scaffold", name: "Create Samaya files", callback: () => this.scaffold(true) });

    // journal notes get a class that hides their properties block (styles.css)
    const marks = () => { void this.markJournalNotes(); };
    this.registerEvent(this.app.workspace.on("file-open", marks)); this.registerEvent(this.app.workspace.on("layout-change", marks)); this.registerEvent(this.app.workspace.on("active-leaf-change", marks));
    this.register(this.bus.on(marks));
    this.registerEvent(this.app.metadataCache.on("changed", f => { if (f.path.startsWith(prefixOf(this.settings.tasksPath)) || (sideLeaf(this.app)?.view as { file?: TFile } | undefined)?.file === f) marks(); })); // the side pane's note changed (e.g. a meeting's title): redraw its bar
    this.registerEvent(this.app.vault.on("rename", () => marks()));
    this.registerEvent(this.app.metadataCache.on("changed", f => { if (this.indexLunch(f)) this.bus.emit(); void this.fileByPlanned(f); }));
    // Tasks sections of project / ticket notes follow task assignments (and their dates)
    const tl = (f: { path: string }) => { if (affectsTaskLists(this.settings, f.path)) this.scheduleTaskLists(); };
    this.registerEvent(this.app.metadataCache.on("changed", tl));
    this.registerEvent(this.app.vault.on("delete", tl)); this.registerEvent(this.app.vault.on("rename", tl));
    this.registerEvent(this.app.vault.on("create", f => { if (this.app.workspace.layoutReady) this.scheduleTaskLists(); void f; }));
    const ref = this.app.metadataCache.on("resolved", () => { this.scheduleTaskLists(); this.scanLunch(); void this.fileAllByPlanned(); this.app.metadataCache.offref(ref); });
    // body class while the left sidebar is folded: the planner centres its columns then
    const leftState = () => document.body.toggleClass("samaya-left-collapsed", !!this.app.workspace.leftSplit?.collapsed);
    this.register(() => document.body.removeClass("samaya-left-collapsed"));
    for (const ev of ["layout-change", "resize", "active-leaf-change"] as const) this.registerEvent(this.app.workspace.on(ev as "resize", leftState));
    this.nav.init();
    this.app.workspace.onLayoutReady(async () => {
      leftState();
      void this.nav.apply();
      this.app.workspace.detachLeavesOfType("samaya-journal-calendar"); // left over from older versions
      this.scanLunch();
      void this.markJournalNotes();
      await this.scaffold(false);
      if (this.settings.syncOnStartup && (this.settings.jiraOn || this.settings.gitlabOn)) void this.syncTickets();
      if (this.settings.openOnStartup) await this.openPlanner();
      this.registerInterval(window.setInterval(() => this.shutdownNudge(), 60000));
      const promote = () => { void promoteParked(this.app, this.settings); };
      promote(); this.registerInterval(window.setInterval(promote, 10 * 60000)); // parked backlog tasks reaching their date move to this week
    });
  }

  /** Keep task notes in the tasks-path subfolder of their scheduled (planned) date; unscheduled ones go to "Unscheduled". */
  private taskListTimer = 0; private taskListRun: Promise<void> = Promise.resolve();
  /** Rewrite the Tasks sections of project and ticket notes (debounced; runs one at a time). */
  scheduleTaskLists() {
    window.clearTimeout(this.taskListTimer);
    this.taskListTimer = window.setTimeout(() => {
      this.taskListRun = this.taskListRun.then(() => syncTaskLists(this.app, this.settings)).catch(e => { console.warn("Samaya: task lists failed", e); });
    }, 1500);
  }
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
  /** What counts as work time on a day: from the start line, minus breaks and lunch (see workedOn). */
  get dayRules(): RulesFor { return d => ({ from: this.workWindowFor(d)[0], lunch: this.lunchFor(d) }); }
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

  /** Projects folder (only when the module is on). */
  async scaffoldProjects(_announce: boolean) {
    if (!this.settings.projectsOn) return;
    await ensureFolder(this.app, normalizePath(this.settings.projectsPath.trim() || "Projects"));
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

  /** Tickets folder (only while Jira or GitLab is on). */
  async scaffoldTickets(_announce: boolean) {
    if (!this.settings.jiraOn && !this.settings.gitlabOn) return;
    const folder = rootOf(this.settings.ticketsPath);
    if (folder !== "/") await ensureFolder(this.app, folder);
  }
  async scaffoldJournal(_announce: boolean) { /* the journal needs no files of its own */ }
  private marking = false; private markAgain = false;
  /** Per open note tab: mark journal notes with `samaya-journal-note` (hides their title and properties, styles.css) and show / remove the navigation bar. Runs one at a time. */
  async markJournalNotes() {
    if (this.marking) { this.markAgain = true; return; }
    this.marking = true;
    try {
      do {
        this.markAgain = false;
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) await this.markLeaf(leaf);
        renderSideBars(this);
      } while (this.markAgain);
    } finally { this.marking = false; }
  }
  /** One note tab: journal / task marks, the task card, the journal bar. */
  private async markLeaf(leaf: import("obsidian").WorkspaceLeaf) {
    const s = this.settings;
    const file = (leaf.view as { file?: TFile }).file; const el = leaf.view.containerEl;
    const isTask = !!file && file.extension === "md" && file.path.startsWith(prefixOf(s.tasksPath));
    // tasks, tickets and meetings are never journal notes: no need to look them up (that is the slow part)
    const other = !!file && (isTask || file.path.startsWith(prefixOf(s.ticketsPath)) || file.path.startsWith(normalizePath(s.eventNotesFolder.trim() || "Meetings") + "/"));
    const id = s.journalOn && !!file && !other ? await identifyNote(this.app, s, file) : null;
    el.toggleClass("samaya-journal-note", s.journalHideProps && !!id);
    el.toggleClass("samaya-task-note", isTask); // hides the properties; the task card shows them instead
    renderTaskCard(this, el, isTask ? file! : null, leaf === sideLeaf(this.app));
    await this.renderJournalBar(leaf, el, s.journalNavBar && file && id ? { file, ...id } : null);
  }
  /** The note in the side pane, dressed at once (its own tab only, not every open note) and shown. */
  async dressSide() {
    const side = sideLeaf(this.app);
    if (side && side.view.getViewType() === "markdown") await this.markLeaf(side);
    renderSideBars(this);
  }
  private async renderJournalBar(leaf: import("obsidian").WorkspaceLeaf, el: HTMLElement, cur: { file: TFile; p: Period; date: string } | null) {
    const bars = () => Array.from(el.querySelectorAll<HTMLElement>(":scope > .samaya-journal-bar"));
    if (!cur) { bars().forEach(b => b.remove()); return; }
    const s = this.settings;
    const { prev, next } = neighbours(await listPeriodNotes(this.app, s, cur.p), cur.date);
    const nowNote = await periodNotePath(this.app, s, cur.p, today());
    const isNow = nowNote?.path === cur.file.path;
    const key = JSON.stringify([cur.file.path, cur.p, cur.date, prev?.file.path, next?.file.path, isNow, PERIODIC_KINDS.filter(k => s.journalNotes[k].on)]);
    const existing = bars(); // no await below: check, clean up and insert in one go
    if (existing.length === 1 && existing[0].dataset.key === key) return;
    existing.forEach(b => b.remove());
    const content = el.querySelector(":scope > .view-content"); if (!content) return;
    const bar = createDiv({ cls: "samaya-journal-bar samaya-day-head" }); bar.dataset.key = key;
    renderJournalBar(this, leaf, bar, cur, prev?.file ?? null, next?.file ?? null, isNow);
    el.insertBefore(bar, content);
  }
  /** Open a note in the side view (see openfile.ts). */
  async openNoteInMain(file: TFile) { await openNote(this.app, file); }
  async openProjects() { await this.scaffoldProjects(false); await this.openSection("projects"); }
  /** Open the planner (in the current tab when asked) showing a section: "planner" or a module shown on its side rail. */
  async openSection(id: string) {
    await this.openPlanner(id === "planner");
    const v = this.app.workspace.getLeavesOfType(PLANNER_VIEW_TYPE)[0]?.view as PlannerView | undefined;
    await v?.showSectionById(id);
  }

  async scaffold(announce: boolean) {
    await this.scaffoldProjects(announce); await this.scaffoldTickets(announce); await this.scaffoldJournal(announce);
    const folder = rootOf(this.settings.tasksPath);
    if (folder !== "/") await ensureFolder(this.app, folder);
    // Daily notes follow the core plugin; only seed its config when it has none
    const dn = normalizePath(`${this.app.vault.configDir}/daily-notes.json`);
    try {
      if (this.settings.journalOn && !(await this.app.vault.adapter.exists(dn))) await this.app.vault.adapter.write(dn, JSON.stringify({ folder: rootOf(this.settings.journalFolder).replace(/^\/$/, ""), format: "YYYY-MM-DD" }, null, 2));
    } catch (e) { console.warn("Samaya: could not seed daily-notes.json", e); }

    await this.removeSamayaBases();
  }

  /** The modules used to live in base files (Tasks.base, Journal.base, ...): they are shown inside the planner now, so the bases made for Samaya's views are moved to the trash (recoverable). */
  private async removeSamayaBases() {
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== "base") continue;
      const txt = await this.app.vault.read(f);
      if (/^\s*- type: samaya-(daily|backlog|backlog-buckets|kanban|gantt|journal|meetings)\s*$/m.test(txt) && !/^\s*- type: (?!samaya-|table\b)/m.test(txt)) {
        const dir = f.parent; await this.app.fileManager.trashFile(f);
        if (dir && !dir.isRoot() && dir.children.length === 0) await this.app.fileManager.trashFile(dir);
      }
    }
  }

  /** Open the planner in its own tab, showing a day (the day planner) or the week of a date (the week view). */
  async openPlannerAt(kind: "day" | "week", date: string) {
    await this.openPlanner(); await this.openSection("planner");
    const v = this.app.workspace.getLeavesOfType(PLANNER_VIEW_TYPE)[0]?.view as PlannerView | undefined;
    if (kind === "day") v?.showDay(date); else v?.showWeek(date);
  }
  /** Open (or focus) the planner in the MAIN area, even when called from a sidebar. */
  async openPlanner(inCurrentTab = false) {
    await this.scaffold(false);
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(PLANNER_VIEW_TYPE)[0];
    if (!leaf) { leaf = inCurrentTab ? ws.getLeaf(false) : ws.getLeaf("tab"); await leaf.setViewState({ type: PLANNER_VIEW_TYPE, active: true }); }
    await ws.revealLeaf(leaf);
    ws.rightSplit?.collapse(); // the planner and its guides need no sidebar
    ws.setActiveLeaf(leaf, { focus: true });
  }
  /** Redraw the open planner (its options changed). */
  refreshPlanner() { this.app.workspace.getLeavesOfType(PLANNER_VIEW_TYPE).forEach(l => { if (l.view instanceof PlannerView) l.view.onDataUpdated(); }); } // a planner tab that is not loaded yet (right after start-up) has no view to redraw
  /** The work time dashboard lives in the Planner: it takes the place of the day / week there, with a button back. */
  async openDashboard() {
    await this.openPlanner();
    if (this.guide) return; // a guide is running: it keeps the planner
    this.showWorkTime();
  }
  /** Interactive planning: opens the daily planner and walks through it (see views/guide.ts). */
  private leftCollapsedByGuide = false;
  /** Leaves the guide and brings the left sidebar back if the guide hid it. */
  /** The X of a guide: Plan my week goes back to the week view (of the week being planned), the day guides just close. */
  cancelGuide() {
    const g = this.guide; const wk = g?.kind === "week" ? g.week ?? "" : null;
    const left = this.closeGuide(wk !== null);
    if (wk !== null) { this.weekToShow = wk; this.expandTimeline(left); }
  }
  /** `keepLeft`: the left sidebar stays folded (the week view follows); returns whether the guide had hidden it. */
  closeGuide(keepLeft = false): boolean {
    this.guide = null; const hid = this.leftCollapsedByGuide;
    if (hid) { this.leftCollapsedByGuide = false; if (!keepLeft) this.app.workspace.leftSplit?.expand(); }
    this.modeBus.emit();
    this.bus.emit();
    return hid;
  }
  /** Interactive week plan: Review, Tickets, Backlog, Schedule, Check (see views/guide.ts and WeeklyBoardView). The left sidebar makes room; This week is the last column. */
  async startWeekGuide() {
    if (this.focus.state) { new Notice("Samaya: stop or finish the running focus before planning the week."); return; }
    if (this.collapseTimeline(true)) this.leftCollapsedByGuide = true;
    const ws = this.app.workspace; const now = new Date(); const wk = weekToPlan(today(), now.getDay());
    const leftover = allTasks(this.app, this.settings).some(t => isLeftover(t, today(), wk));
    const tickets = (this.settings.jiraOn || this.settings.gitlabOn) && allTickets(this.app, this.settings).some(t => !/(done|closed|resolved|complete|finished|released|cancel)/i.test(t.state));
    this.guide = { step: weekSteps(leftover, tickets)[0], review: leftover, fresh: true, kind: "week", week: wk, tickets };
    await this.openPlanner();
    if (ws.leftSplit && !ws.leftSplit.collapsed) { ws.leftSplit.collapse(); this.leftCollapsedByGuide = true; }
    this.modeBus.emit(); this.bus.emit();
  }
  async finishWeekGuide() {
    const g = this.guide; const wk = g?.week; const days = g?.days ?? 5;
    const left = this.closeGuide(true);
    this.weekToShow = wk ?? ""; this.expandTimeline(left); // back to the week view (not the day), on the week that was planned
    if (!wk) return;
    let saved: TFile | null = null; this.weekWritten = false;
    try { saved = await this.writeWeekPlan(wk, days); } catch (e) { console.error("Samaya: could not write the weekly note", e); new Notice("Samaya: could not write the weekly note (see the console)."); }
    this.noticeWithNote(`Week of ${parseYmd(wk).toLocaleDateString(undefined, { month: "short", day: "numeric" })} planned${saved && this.weekWritten ? " and saved to your weekly note" : ""}.`, saved, "Open weekly note", true);
  }
  /** The weekly note (created if missing) gets an "Overview", the week's "Meetings" by weekday and its "Planned tasks". False when nothing is written. */
  private weekWritten = false;
  private async writeWeekPlan(wk: string, nDays: number): Promise<TFile | null> {
    const s = this.settings; const wantPlan = journalWants(s, "journalWeekPlan"), wantMeet = journalWants(s, "journalWeekMeetings"), wantTasks = journalWants(s, "journalWeekTasks");
    if (!s.journalNotes.weekly.on || !(wantPlan || wantMeet || wantTasks)) return null;
    const file = await openPeriodNote(this.app, s, "weekly", wk); if (!file) return null;
    const before = await this.app.vault.read(file);
    if ([WEEK_OVERVIEW, WEEK_MEETINGS, WEEK_TASKS].some(h => readSection(before, h as Parameters<typeof readSection>[1]).length) && !(await this.askOverwrite("weekly note"))) return file; // planned before: ask first (declined: nothing written)
    this.weekWritten = true;
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
        events: wantMeet ? await Promise.all(dayEvents.map(async e => ({ ...e, note: e.allDay ? undefined : await ensureMeetingNote(this.app, e).then(f => f.basename, () => undefined) }))) : dayEvents });
    }
    const unscheduled = (await toJournalTasks(this.app, noDay)).map(t => ({ ...t, day: "no day" }));
    await this.app.vault.process(file, t => {
      let x = t; for (const h of [...LEGACY_WEEK_HEADINGS, ...plans.map(p => p.label)]) x = removeSection(x, h); // sections written by earlier versions
      if (wantPlan) x = upsertSection(x, WEEK_OVERVIEW, weekOverview(plans, noDay.length), WEEK_ORDER);
      if (wantMeet) x = upsertSection(x, WEEK_MEETINGS, weekMeetings(plans), WEEK_ORDER);
      if (wantTasks) x = upsertSection(x, WEEK_TASKS, taskLines([...unscheduled, ...plans.flatMap(p => p.tasks)]), WEEK_ORDER);
      return x;
    });
    return file;
  }



  /** A notice with a button that opens the note the planning just wrote. */
  private noticeWithNote(msg: string, file: TFile | null, label: string, autoOpen = false) {
    if (!file) { new Notice(msg); return; }
    if (autoOpen && this.settings.journalOpenAfterPlan) { new Notice(msg); void this.openNoteInMain(file); return; }
    const frag = document.createDocumentFragment(); frag.createDiv({ text: msg });
    const n = new Notice(frag, 12000);
    frag.createEl("button", { text: label, cls: "mod-cta" }).onclick = () => { n.hide(); void this.openNoteInMain(file); };
  }
  async startGuide() {
    if (this.focus.state) { new Notice("Samaya: stop or finish the running focus first."); return; }
    this.collapseTimeline();
    const ls = this.app.workspace.leftSplit;
    if (ls && !ls.collapsed) { ls.collapse(); this.leftCollapsedByGuide = true; } // room for the planner while planning
    const overdue = allTasks(this.app, this.settings).some(isOverdue);
    this.guide = { step: overdue ? 0 : 1, review: overdue, fresh: true, kind: "plan" };
    await this.openPlanner(); this.bus.emit();
  }
  /** Ask whether a plan that is already written in a note may be replaced. Closing the dialog says no. */
  private askOverwrite(noteLabel: string): Promise<boolean> {
    return new Promise(res => { new ConfirmOverwriteModal(this, noteLabel, res).open(); });
  }
  async finishGuide() {
    const g = this.guide; if (!g) return; const s = this.settings; const td = today();
    const day = sortTasks(onDay(allTasks(this.app, s), td));
    const planned = journalWants(s, "journalPlanned") && (await readJournalSection(this.app, s, td, "Planned tasks")).length > 0;
    const write = !planned || (await this.askOverwrite("daily note")); // planned before: ask first
    if (write && s.journalOn && calendarEnabled(s)) {
      const from = parseYmd(td); const evs = await calendarEvents(this, from, parseYmd(addDays(td, 1))).catch(() => null);
      if (evs) await writeSection(this.app, s, td, "Meetings", meetingLines(await Promise.all(evs.map(async e => ({ ...e, note: e.allDay ? undefined : await ensureMeetingNote(this.app, e).then(f => f.basename, () => undefined) })))));
    }
    if (write && journalWants(s, "journalPlanned")) await writeSection(this.app, s, td, "Planned tasks", taskLines(await toJournalTasks(this.app, sortByStart(day), false, true)));
    const plans = (this.data.dayPlans ??= {}); // the first plan of the day stays as the baseline; planning again does not replace it
    if (!plans[td]) {
      plans[td] = day.map(t => ({ path: t.file.path, est: t.estimate, slots: dayPieces(t.sessions, td).filter(g => g.s !== null).map((g): [number, number] => [g.s!, g.dur]) }));
      for (const d of Object.keys(plans)) if (d < addDays(td, -60)) delete plans[d];
      await this.saveData(this.data);
    }
    const wasStarted = this.workday.started;
    await this.workday.startDay();
    this.closeGuide();
    const note = s.journalOn ? (await periodNotePath(this.app, s, "daily", td))?.file ?? null : null;
    this.noticeWithNote(`Day planned${wasStarted ? "" : " and started"}.${s.journalOn && write ? " Saved to your journal." : ""}`, note, "Open daily note", true);
  }
  /** End of day: the planner with a two-step guide (tick off forgotten tasks, review the day), then finalize. */
  async startShutdown() {
    if (this.focus.state) { new Notice("Samaya: stop or finish the running focus first."); return; }
    this.collapseTimeline();
    const td = today(); const day = onDay(allTasks(this.app, this.settings), td);
    this.guide = { step: day.every(t => t.status === "done") ? 1 : 0, // nothing left to check off: straight to the review
       review: false, fresh: true, kind: "shutdown" };
    await this.openPlanner(); this.bus.emit();
  }
  /** Closing a day (by hand or automatically, because it was forgotten) writes its finished tasks and a summary of its review into that day's note. */
  async writeDayClose(date: string) {
    const s = this.settings;
    const all = allTasks(this.app, s);
    const finished = sortTasks(onDay(all, date).filter(t => t.status === "done"));
    if (journalWants(s, "journalFinished")) await writeSection(this.app, s, date, "Finished tasks", taskLines(await toJournalTasks(this.app, finished, true)));
    if (journalWants(s, "journalReview")) {
      const { items, hasPlan } = reviewItems(this, all, date); const log = this.workday.allLogs().find(l => l.date === date) ?? null; const now = nowMin();
      const body = reviewSummary({ items, hasPlan, window: this.workWindowFor(date), start: log?.start ? hmToMin(log.start) : null, end: log?.start ? (log.end ? hmToMin(log.end) : date === today() ? now : null) : null,
        worked: workedOn(log, now, this.dayRules), ref: t => `[[${t}]]` });
      await writeSection(this.app, s, date, "Productivity review", body);
    }
  }
  async finishShutdown() {
    const s = this.settings; const td = today();
    await this.writeDayClose(td);
    await this.workday.endDay();
    this.closeGuide();
    const note = s.journalOn ? (await periodNotePath(this.app, s, "daily", td))?.file ?? null : null;
    this.noticeWithNote(`Day ended${s.journalOn ? " - saved to your journal" : ""}. See you tomorrow.`, note, "Open daily note");
  }

  quickAdd() {
    new TextPromptModal(this, "New task (append 30m / 1h for an estimate)", raw => {
      const p = parseTitleEstimateSafe(raw);
      void createTask(this.app, this.settings, p.title, { planned: today(), estimate: p.estimate ?? this.settings.defaultEstimate });
    }).open();
  }

  /** New task assigned to a ticket (and to the ticket's project); left unplanned so it lands in the backlog. */
  newTaskForTicket(t: Ticket) {
    new TextPromptModal(this, `New task for ${t.key} (append 30m / 1h for an estimate)`, raw => {
      const p = parseTitleEstimateSafe(raw);
      const pf = this.settings.projectsOn ? this.app.vault.getAbstractFileByPath(projectPathOf(this.app, t.file)) : null;
      void createTask(this.app, this.settings, p.title, { estimate: p.estimate ?? this.settings.defaultEstimate, ticket: `[[${t.file.basename}]]`, ...(pf instanceof TFile ? { samaya_project: `[[${pf.basename}]]` } : {}) }).then(() => this.bus.emit());
    }, t.summary).open();
  }

  /** New task assigned to a project (and to its only ticket, if it is linked to exactly one single ticket; a project linked to a whole ticket project gives its tasks no ticket); left unplanned so it lands in the backlog. */
  newTaskForProject(project: TFile) {
    new TextPromptModal(this, `New task for ${project.basename} (append 30m / 1h for an estimate)`, raw => {
      const p = parseTitleEstimateSafe(raw);
      const tickets = allTickets(this.app, this.settings).filter(t => projectPathOf(this.app, t.file) === project.path);
      const project_tp = !!this.app.metadataCache.getFileCache(project)?.frontmatter?.ticket_project; // linked to a whole ticket project
      void createTask(this.app, this.settings, p.title, { estimate: p.estimate ?? this.settings.defaultEstimate, samaya_project: `[[${project.basename}]]`, ...(tickets.length === 1 && !project_tp ? { ticket: `[[${tickets[0].file.basename}]]` } : {}) }).then(() => this.bus.emit());
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
