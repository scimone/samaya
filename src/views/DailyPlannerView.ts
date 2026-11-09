import { BasesView, Notice, QueryController, TFile, WorkspaceLeaf } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, allTasks, prefixOf, createTask, patchTask, placeInDay, readTask, sortTasks } from "../model";
import { addDays, fmtDur, parseTitleEstimate, parseYmd, startOfWeek, today } from "../util";
import { bindCardDrop, bindZone, renderTaskCard, richText } from "./common";
import type { IcsEvent } from "../ics";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { renderDoneBar } from "./doneBar";
import { renderGuide } from "./guide";
import { renderLoadBar } from "./loadBar";
import { renderWorkdayCard } from "./workdayCard";
import { capacityWindow, Capacity } from "../worktime";

export const DAILY_VIEW_TYPE = "samaya-daily";

export class DailyPlannerView extends BasesView {
  readonly type = DAILY_VIEW_TYPE;
  private root: HTMLElement;
  private date = today();
  private scope = new DndScope();
  private pending = false;
  private timer = 0;
  private token = 0;
  private leftScroll = 0;
  private announced = false;
  private pickTab: "week" | "backlog" = "week";

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    this.root = parentEl.createDiv("samaya-daily");
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
    this.register(plugin.bus.on(() => this.schedule()));
    const evRef = plugin.app.metadataCache.on("changed", f => { if (inEventFolder(plugin.settings, f.path) || (this.plugin.guide && f.path.startsWith(prefixOf(plugin.settings.tasksPath)))) this.schedule(); });
    this.register(() => plugin.app.metadataCache.offref(evRef));
    this.showSidebar();
  }

  /** The timeline lives in the right sidebar: open it with this view, and give the focus back to the planner. */
  private showSidebar() {
    const ws = this.app.workspace;
    ws.onLayoutReady(() => window.setTimeout(() => {
      const mine: WorkspaceLeaf[] = []; ws.iterateRootLeaves(l => { if (l.view.containerEl.contains(this.root)) mine.push(l); });
      const was = mine.length > 0 && ws.getMostRecentLeaf() === mine[0];
      void this.plugin.openToday().then(() => { if (was) ws.setActiveLeaf(mine[0], { focus: true }); });
    }, 0));
  }

  private get showIcs() { return this.config.get("showIcs") !== false; }
  /** While planning my day, read the vault directly: a task just added must show up at once, not when the base has refreshed. */
  private entryTasks(): Task[] { return this.plugin.guide ? allTasks(this.app, this.plugin.settings) : this.data.data.map(e => readTask(this.app, e.file)); }

  onDataUpdated(): void { this.schedule(); }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); window.setTimeout(() => this.plugin.modeBus.emit(), 80); }

  /** Coalesce bursts of updates; never re-render in the middle of a drag. */
  private schedule() {
    if (this.scope.active && !document.querySelector(".samaya-ghost")) this.scope.active = false; // a drag that never ended must not freeze the view
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.render(); }, 30);
  }

  private async render() {
    const token = ++this.token;
    const guide = this.plugin.guide;
    if (guide?.fresh) { guide.fresh = false; this.date = today(); }
    const events = this.showIcs && calendarEnabled(this.plugin.settings)
      ? await calendarEvents(this.plugin, parseYmd(this.date), parseYmd(addDays(this.date, 1))) : [];
    if (token !== this.token || this.scope.active) { if (this.scope.active) this.pending = true; return; }

    const lp = this.root.querySelector<HTMLElement>(".samaya-left"); if (lp) this.leftScroll = lp.scrollTop;
    this.root.empty(); this.scope.clear();

    const all = this.entryTasks(); const isToday = this.date === today();
    const day = sortTasks(all.filter(t => t.planned === this.date));
    const overdue = isToday ? sortTasks(all.filter(t => t.planned && t.planned < today() && t.status !== "done")) : [];

    // free capacity = capacity - lunch - calendar meetings
    const s = this.plugin.settings; const dayMs = parseYmd(this.date).getTime();
    const cap = capacityWindow(...this.plugin.workWindowFor(this.date), this.plugin.lunchFor(this.date),
      events.filter(e => !e.allDay).map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]));
    const plannedAll = day.reduce((a, t) => a + (t.estimate || 0), 0);

    const g = isToday ? this.plugin.guide : null; const step = g?.step ?? -1;
    const review = step === 0, pick = step === 1;
    this.root.toggleClass("is-review", !!g); // plan my day: guide + columns; otherwise one column of task cards on the right
    const info = g ? null : this.root.createDiv("samaya-info"); // day title, workday, navigation, totals
    const left = this.root.createDiv("samaya-left");
    this.renderHeader(info ?? left, day, cap, plannedAll, isToday, !!g);
    let body = left; // where today's planned list goes
    if (!g) {
      const h = left.createDiv("samaya-colhead");
      h.createSpan({ cls: "samaya-colhead-title", text: "Tasks" });
      h.createSpan({ cls: "samaya-colhead-count", text: String(day.length) });
    }
    if (g) {
      // columns: guide | source tasks (Review: left over, Pick: this week/backlog) | today's tasks
      const cols = left.createDiv("samaya-review-cols" + (step === 2 ? " is-two" : ""));
      renderGuide(this.plugin, cols, { overdue: overdue.length });
      if (review) this.renderLeftOver(cols, overdue); else if (pick) this.renderPick(cols);
      body = cols.createDiv("samaya-plancol samaya-review-main");
      this.colHead(body, "Today", day.length, review ? "Drag overdue tasks here, or press `Today` on one." : pick ? "Drag tasks here, or press `Today` on a task." : "Drag tasks onto the timeline in the sidebar to give them a time slot, and back here to take it away.");
      renderLoadBar(body, plannedAll, cap.free, `Free capacity = ${fmtDur(cap.total)} capacity - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`);
    }

    const list = body.createDiv("samaya-list" + (step === 2 ? " is-timebox" : ""));
    if (!day.length) list.createDiv({ cls: "samaya-empty", text: this.plugin.guide ? "Nothing planned yet." : "Nothing planned. Drag tasks here or add one below." });
    // Timebox: tasks without a time slot always first
    const shown = step === 2 ? [...day.filter(t => !t.start && t.status !== "done"), ...day.filter(t => t.start || t.status === "done")] : day;
    shown.forEach(t => {
      const idx = day.indexOf(t);
      const c = renderTaskCard(this.plugin, list, t, { scope: this.scope, showTime: true });
      c.toggleClass("is-timed", !!t.start);
      bindCardDrop(this.scope, c, (path, after, i) => { void this.place(path, idx + (after ? 1 : 0), i.fromTimeline); });
    });
    bindZone(this.scope, list, (path, i) => { void this.place(path, day.length, i.fromTimeline); });

    if (!review && step !== 2) { // (no quick add in Review and Timebox: go back to Pick to add tasks)
      const add = body.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: "+ Add task  (e.g. “Write report 1h”)" } });
      this.bindAdd(add, () => ({ planned: this.date, order: day.length }));
    }

    left.scrollTop = this.leftScroll;

    if (!this.announced || this.plugin.plannerDate !== this.date) { this.announced = true; this.plugin.plannerDate = this.date; this.plugin.modeBus.emit(); }
  }

  /** Review step: the left over tasks as a panel next to the guide. Decide with a button, or drag onto today's list or the sidebar timeline. */
  /** Put a task into today's list at `index`; a task dragged off the timeline loses its time slot. */
  private async place(path: string, index: number, unschedule: boolean) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (unschedule && f instanceof TFile) await patchTask(this.app, f, { start: null });
    await placeInDay(this.app, this.plugin.settings, path, this.date, index);
  }

  private colHead(host: HTMLElement, title: string, count: number, hint: string) {
    const h = host.createDiv("samaya-colhead");
    h.createSpan({ cls: "samaya-colhead-title", text: title });
    h.createSpan({ cls: "samaya-colhead-count", text: String(count) });
    richText(host.createDiv("samaya-guide-text samaya-colhint"), hint);
  }

  /** Pick step: This week / Backlog with full task cards. Press Today or drag a card into today's list; new tasks can be added here too. */
  private renderPick(host: HTMLElement) {
    const s = this.plugin.settings; const wk = startOfWeek(today());
    const open = allTasks(this.app, s).filter(t => !t.planned && t.status !== "done");
    const week = sortTasks(open.filter(t => t.week === wk)), backlog = sortTasks(open.filter(t => t.week !== wk));
    const col = host.createDiv("samaya-plancol samaya-pick");
    const tasks = this.pickTab === "week" ? week : backlog;
    const head = col.createDiv("samaya-colhead");
    ([["week", "This week", week.length], ["backlog", "Backlog", backlog.length]] as const).forEach(([key, label, n]) => {
      const b = head.createEl("button", { cls: "samaya-colhead-tab" + (this.pickTab === key ? " is-active" : "") });
      b.createSpan({ cls: "samaya-colhead-title", text: label }); b.createSpan({ cls: "samaya-colhead-count", text: String(n) });
      b.onclick = () => { this.pickTab = key; void this.render(); };
    });
    richText(col.createDiv("samaya-guide-text samaya-colhint"), "Press `Today` on a task, or drag it into today's list.");
    const list = col.createDiv("samaya-leftover-list");
    if (!tasks.length) list.createDiv({ cls: "samaya-empty", text: this.pickTab === "week" ? "Nothing planned for this week yet." : "Backlog is empty." });
    tasks.forEach(t => renderTaskCard(this.plugin, list, t, {
      scope: this.scope,
      actionsSide: true,
      actions: [["Today", () => { void placeInDay(this.app, s, t.file.path, this.date, 9999); }]],
    }));
    bindZone(this.scope, col, path => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) void patchTask(this.app, f, { planned: null, start: null, week: this.pickTab === "week" ? wk : null });
    });
    const add = col.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: this.pickTab === "week" ? "+ Add weekly task" : "+ Add to backlog" } });
    this.bindAdd(add, (): Record<string, string | number> => (this.pickTab === "week" ? { week: wk } : {}));
  }

  /** "+ Add task" field: Enter creates the task with `extra` properties, then the lists refresh. Failures are shown instead of swallowed. */
  private bindAdd(input: HTMLInputElement, extra: () => Record<string, string | number>) {
    const s = this.plugin.settings;
    input.addEventListener("keydown", e => {
      if (e.key !== "Enter" || e.isComposing || !input.value.trim()) return;
      const p = parseTitleEstimate(input.value); const props = { ...extra(), estimate: p.estimate ?? s.defaultEstimate };
      input.value = "";
      createTask(this.app, s, p.title, props)
        .then(() => { window.setTimeout(() => this.schedule(), 250); }) // the metadata cache needs a moment to index the new note
        .catch((err: unknown) => { console.error("Samaya: could not create task", err); new Notice(`Samaya: could not create the task (${err instanceof Error ? err.message : String(err)})`); });
    });
  }

  private renderLeftOver(host: HTMLElement, overdue: Task[]) {
    const col = host.createDiv("samaya-plancol samaya-leftover");
    this.colHead(col, "Overdue", overdue.length, "Press `Today`, `Tomorrow`, `This week` or `Backlog`, or drag a task into today's list.");
    const list = col.createDiv("samaya-leftover-list");
    if (!overdue.length) list.createDiv({ cls: "samaya-empty", text: "Nothing overdue." });
    const tomorrow = addDays(today(), 1);
    overdue.forEach(t => renderTaskCard(this.plugin, list, t, {
      scope: this.scope,
      actions: [
        ["Today", () => { void patchTask(this.app, t.file, { planned: today(), start: null }); }],
        ["Tomorrow", () => { void patchTask(this.app, t.file, { planned: tomorrow, start: null }); }],
        ["This week", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: startOfWeek(today()) }); }],
        ["Backlog", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: null }); }],
      ],
    }));
  }

  private fileOf(path: string): TFile { return this.app.vault.getAbstractFileByPath(path) as TFile; }

  private renderHeader(left: HTMLElement, day: Task[], cap: Capacity, plannedAll: number, isToday: boolean, guided: boolean) {
    const head = left.createDiv("samaya-head samaya-top");
    const row = head.createDiv("samaya-top-row");
    const d = parseYmd(this.date);
    const title = row.createEl("h2", { text: isToday ? "Today" : d.toLocaleDateString(undefined, { weekday: "long" }) });
    title.createSpan({ cls: "samaya-date", text: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) });
    if (guided) return; // plan my day: no day navigation, workday strip, totals or progress here
    const nav = row.createDiv("samaya-nav samaya-nav-min");
    const go = (x: string) => { this.date = x; void this.render(); };
    nav.createEl("button", { text: "‹", cls: "samaya-link-btn" }).onclick = () => go(addDays(this.date, -1));
    nav.createEl("button", { text: "Today", cls: "samaya-link-btn" }).onclick = () => go(today());
    nav.createEl("button", { text: "›", cls: "samaya-link-btn" }).onclick = () => go(addDays(this.date, 1));
    if (isToday) renderWorkdayCard(this.plugin, head.createDiv());
    const done = day.filter(t => t.status === "done").length;
    const tot = head.createDiv({ cls: "samaya-total" + (plannedAll > cap.free ? " is-over" : ""), text: `${fmtDur(plannedAll)} / ${fmtDur(cap.free)} planned` });
    tot.title = `Free capacity = ${fmtDur(cap.total)} capacity - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`;
    renderDoneBar(head, done, day.length);
  }

}
