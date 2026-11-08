import { Editor, MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, SamayaSettings, SamayaSettingTab, migrateSettings } from "./settings";
import { FOCUS_VIEW_TYPE, FocusManager, FocusState, FocusView } from "./focus";
import { IcsClient, assignTicket, createTask } from "./model";
import { DAILY_VIEW_TYPE, DailyPlannerView } from "./views/DailyPlannerView";
import { WEEK_VIEW_TYPE, WeeklyBoardView } from "./views/WeeklyBoardView";
import { WTL_VIEW_TYPE, WeeklyTimelineView } from "./views/WeeklyTimelineView";
import { BACKLOG_VIEW_TYPE, BacklogView } from "./views/BacklogView";
import { syncTickets } from "./sync";
import { TODAY_VIEW_TYPE, TodayView } from "./views/TodayView";
import { ShutdownModal, TextPromptModal, TicketSuggestModal } from "./modals";
import { DASHBOARD_VIEW_TYPE, DashboardView } from "./views/DashboardView";
import { allTasks, sortTasks, prefixOf, rootOf, ensureFolder, folderFor, readTask } from "./model";
import { bulletLines, journalPath, readJournalSection, setJournalProps, taskLines, toJournalTasks, writeSection } from "./journal";
import { Emitter, addDays, hmToMin, parseTitleEstimate as parseTitleEstimateSafe, today } from "./util";
import { WorkdayManager } from "./workday";
import type { DayLog } from "./worktime";

interface PluginData { settings?: Partial<SamayaSettings>; focus?: FocusState | null; workday?: DayLog | null; }
export interface GuideState { step: number; obstacles: string | null; shutdown: string; fresh: boolean; }

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
    name: Daily Planner
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
    this.registerView(DASHBOARD_VIEW_TYPE, leaf => new DashboardView(leaf, this));
    this.registerView(TODAY_VIEW_TYPE, leaf => new TodayView(leaf, this));
    this.registerView(FOCUS_VIEW_TYPE, leaf => new FocusView(leaf, this));
    this.addSettingTab(new SamayaSettingTab(this.app, this));

    const ok = (id: string, name: string, icon: string, factory: Parameters<Plugin["registerBasesView"]>[1]["factory"], options: Parameters<Plugin["registerBasesView"]>[1]["options"]) =>
      this.registerBasesView(id, { name, icon, factory, options });
    const a = ok(DAILY_VIEW_TYPE, "Daily Planner", "lucide-calendar-clock",
      (c, el) => new DailyPlannerView(c, el, this),
      () => [
        { type: "slider", key: "dayStart", displayName: "Day starts (hour)", min: 0, max: 23, step: 1, default: this.settings.dayStartHour },
        { type: "slider", key: "dayEnd", displayName: "Day ends (hour)", min: 1, max: 24, step: 1, default: this.settings.dayEndHour },
        { type: "slider", key: "slot", displayName: "Snap (minutes)", min: 5, max: 60, step: 5, default: this.settings.slotMinutes },
        { type: "toggle", key: "showIcs", displayName: "Show calendar events", default: true },
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
    if (!a || !b || !c || !d) new Notice("Samaya: could not register Bases views. Enable the core Bases plugin and use Obsidian 1.10+.");

    this.addRibbonIcon("calendar-clock", "Open Samaya planner", () => { void this.openPlanner(); });
    this.focus.init(this.addStatusBarItem(), this.data.focus ?? null);
    this.workday.init(this.addStatusBarItem(), this.data.workday ?? null);

    this.addRibbonIcon("calendar-days", "Samaya: today's timeline", () => { void this.openToday(); });
    this.addCommand({ id: "open-today", name: "Open today's timeline in the right sidebar", callback: () => this.openToday() });
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
    this.addCommand({ id: "scaffold", name: "Create planner files", callback: () => this.scaffold(true) });

    this.registerEvent(this.app.metadataCache.on("changed", f => { if (this.indexLunch(f)) this.bus.emit(); void this.fileByPlanned(f); }));
    const ref = this.app.metadataCache.on("resolved", () => { this.scanLunch(); void this.fileAllByPlanned(); this.app.metadataCache.offref(ref); });
    this.app.workspace.onLayoutReady(async () => {
      this.scanLunch();
      await this.scaffold(false);
      if (this.settings.syncOnStartup && (this.settings.jiraOn || this.settings.gitlabOn)) void this.syncTickets();
      if (this.settings.openOnStartup) await this.openPlanner();
      this.registerInterval(window.setInterval(() => this.shutdownNudge(), 60000));
    });
  }

  /** Keep task notes in the tasks-path subfolder of their scheduled (planned) date. Unscheduled tasks stay where they are. */
  async fileByPlanned(f: TFile) {
    if (f.extension !== "md" || !f.path.startsWith(prefixOf(this.settings.tasksPath))) return;
    const { planned } = readTask(this.app, f); if (!planned) return;
    const [y, m, d] = planned.split("-").map(Number);
    const folder = folderFor(this.settings.tasksPath, new Date(y, m - 1, d));
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
    const t = this.settings.shutdownTime.padStart(5, "0");
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
  /** Set the lunch for ONE day and always write it to that day's daily note (null = the current default). */
  async setLunch(date: string, start: string | null, end: string | null) {
    const st = start ?? this.settings.lunchStart, en = end ?? this.settings.lunchEnd;
    const path = await journalPath(this.app, this.settings, date);
    this.lunchIdx.set(path, { date, range: [st, en] }); // optimistic
    this.bus.emit();
    await setJournalProps(this.app, this.settings, date, { date, lunch: `${st}-${en}` });
  }

  async saveSettings() { this.data.settings = this.settings; await this.saveData(this.data); }

  syncTickets(only?: "jira" | "gitlab") { return syncTickets(this, only); }

  async scaffold(announce: boolean) {
    const folder = rootOf(this.settings.tasksPath);
    if (folder !== "/") await ensureFolder(this.app, folder);
    // Daily notes follow the core plugin; only seed its config when it has none
    const dn = normalizePath(`${this.app.vault.configDir}/daily-notes.json`);
    try {
      if (!(await this.app.vault.adapter.exists(dn))) await this.app.vault.adapter.write(dn, JSON.stringify({ folder: rootOf(this.settings.journalFolder).replace(/^\/$/, ""), format: "YYYY-MM-DD" }, null, 2));
    } catch (e) { console.warn("Samaya: could not seed daily-notes.json", e); }

    // Backlog + All tasks live in their own base inside the tasks folder; moved out of the planner base once
    const tp = normalizePath(folder === "/" ? "Tasks.base" : `${folder}/Tasks.base`);
    const tasksBaseNew = !this.app.vault.getAbstractFileByPath(tp);
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
    await this.openToday(); // backlog / this week live in the sidebar while the planner is open
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
  async startGuide() {
    this.guide = { step: 0, obstacles: null, shutdown: this.settings.shutdownTime, fresh: true };
    await this.openPlanner(); this.bus.emit();
  }
  async finishGuide() {
    const g = this.guide; if (!g) return; const s = this.settings; const td = today();
    s.shutdownTime = g.shutdown; await this.saveSettings();
    const day = sortTasks(allTasks(this.app, s).filter(t => t.planned === td));
    await writeSection(this.app, s, td, "Planned today", taskLines(await toJournalTasks(this.app, day)));
    const prior = g.obstacles ?? (await readJournalSection(this.app, s, td, "Obstacles in my way")).join("\n");
    await writeSection(this.app, s, td, "Obstacles in my way", bulletLines(prior.split("\n")));
    await this.workday.startDay();
    this.guide = null; this.bus.emit();
    new Notice("Day planned and started. Saved to your journal.");
  }
  startShutdown() { new ShutdownModal(this).open(); }

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
