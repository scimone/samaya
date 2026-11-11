import { BasesView, Notice, QueryController, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, allTasks, prefixOf, createTask, patchTask, parkTask, placeInDay, readTask, sortTasks, isOverdue } from "../model";
import { addDays, fmtDur, parseTitleEstimate, parseYmd, startOfWeek, today } from "../util";
import type { PlannerHost } from "./plannerHost";
import { bindCardDrop, bindZone, renderBacklogBuckets, renderTaskCard, richText } from "./common";
import type { IcsEvent } from "../ics";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { celebrate, renderDoneBar } from "./doneBar";
import { renderGuide } from "./guide";
import { renderLoadBar } from "./loadBar";
import { renderTimeline, TimelineState } from "./timelineKit";
import { ensureMeetingNote } from "../meetings";
import { capacityWindow, Capacity } from "../worktime";
import { bufferShare, loadLevel, trimToBuffer } from "../weekplan";
import { renderDayHeadStatus, renderDayNoteIcon } from "./headStatus";
import { renderDateNav, renderResetPill } from "./dateNav";
import { dayHeadSub, fitHead, renderHeadTitle, renderModeSwitch } from "./plannerHead";

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
  private infoScroll = 0;
  private announced = false;
  private lastAll: { date: string; all: boolean } | null = null; // to spot the moment the last task of the day gets checked
  private lastOverdue: number | null = null; // Review: to spot the moment the last overdue task gets sorted out
  private lastBoxed: { date: string; all: boolean } | null = null; // Timebox: to spot the moment the last task gets a time slot
  private pickTab: "week" | "backlog" = "week";
  private tlState: TimelineState = { scrolled: "", scrollTop: 0 };
  private tlHeight = 0;
  private tlWatch: ResizeObserver | null = null;

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin, private host?: PlannerHost) {
    super(controller);
    this.root = parentEl.createDiv("samaya-daily");
    const light = (e: MouseEvent, on: boolean) => { // hover a task card or a timeline block: the other one is highlighted too
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-link]"); if (!el) return;
      this.root.querySelectorAll<HTMLElement>("[data-link]").forEach(x => { if (x !== el && x.dataset.link === el.dataset.link) x.toggleClass("is-linked", on); });
    };
    this.root.addEventListener("mouseover", e => light(e, true)); this.root.addEventListener("mouseout", e => light(e, false));
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
    this.register(plugin.bus.on(() => this.schedule()));
    const evRef = plugin.app.metadataCache.on("changed", f => { if (inEventFolder(plugin.settings, f.path) || (this.plugin.guide && f.path.startsWith(prefixOf(plugin.settings.tasksPath)))) this.schedule(); });
    this.register(() => plugin.app.metadataCache.offref(evRef));
    this.registerInterval(window.setInterval(() => { if (!this.host?.hidden() && this.root.isConnected) this.schedule(); }, 60000)); // the now line moves
    plugin.app.workspace.onLayoutReady(() => window.setTimeout(() => { const k = this.plugin.guide?.kind; if (k !== "plan" && k !== "week") this.plugin.app.workspace.rightSplit?.collapse(); }, 0)); // the status column lives in this view now: the right sidebar is not needed (only Plan my day / Plan my week use it)
  }

  private get showIcs() { return this.config.get("showIcs") !== false; }
  /** While planning my day, read the vault directly: a task just added must show up at once, not when the base has refreshed. */
  private entryTasks(): Task[] { return this.plugin.guide ? allTasks(this.app, this.plugin.settings) : this.data.data.map(e => readTask(this.app, e.file)); }

  onDataUpdated(): void { this.schedule(); }
  refresh() { this.schedule(); }
  goTo(date: string) { this.date = date; this.schedule(); }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); window.setTimeout(() => this.plugin.modeBus.emit(), 80); }

  /** Coalesce bursts of updates; never re-render in the middle of a drag. */
  private schedule() {
    if (this.host?.hidden()) return; // the Week pane is showing
    if (this.scope.active && !document.querySelector(".samaya-ghost")) this.scope.active = false; // a drag that never ended must not freeze the view
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.render(); }, 30);
  }

  private async render() {
    const token = ++this.token;
    const guide = this.plugin.guide?.kind === "week" ? null : this.plugin.guide; // the week guide lives in the Weekly Board
    if (guide?.fresh) { guide.fresh = false; this.date = today(); }
    const events = this.showIcs && calendarEnabled(this.plugin.settings)
      ? await calendarEvents(this.plugin, parseYmd(this.date), parseYmd(addDays(this.date, 1))) : [];
    if (token !== this.token || this.scope.active) { if (this.scope.active) this.pending = true; return; }

    const lp = this.root.querySelector<HTMLElement>(".samaya-left"); if (lp) this.leftScroll = lp.scrollTop;
    const ip = this.root.querySelector<HTMLElement>(".samaya-info"); if (ip) this.infoScroll = ip.scrollTop;
    this.root.empty(); this.scope.clear();

    const all = this.entryTasks(); const isToday = this.date === today();
    const day = sortTasks(all.filter(t => t.planned === this.date));
    const overdue = isToday ? sortTasks(all.filter(isOverdue)) : [];

    // free capacity = capacity - lunch - calendar meetings
    const s = this.plugin.settings; const dayMs = parseYmd(this.date).getTime();
    const cap = capacityWindow(...this.plugin.workWindowFor(this.date), this.plugin.lunchFor(this.date),
      events.filter(e => !e.allDay).map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]));
    const plannedAll = day.reduce((a, t) => a + (t.estimate || 0), 0);
    const notes = new Map<IcsEvent, TFile>(); // meeting notes for the timeline
    const tlEvents = !calendarEnabled(s) ? [] : this.showIcs ? events : await calendarEvents(this.plugin, parseYmd(this.date), parseYmd(addDays(this.date, 1)));
    for (const ev of tlEvents.filter(e => !e.allDay)) { try { notes.set(ev, await ensureMeetingNote(this.app, s, ev, tlEvents)); } catch { /* ignore */ } }
    if (token !== this.token || this.scope.active) { if (this.scope.active) this.pending = true; return; }

    const g = isToday ? guide : null; const step = g?.step ?? -1;
    const sd = g?.kind === "shutdown"; const pg = sd ? null : g; const review = !sd && step === 0, pick = !sd && step === 1, check = !sd && step === 3;
    this.root.toggleClass("is-review", !!pg); // plan my day: guide + columns; otherwise one column of task cards
    if (!this.plugin.guide) this.renderHead(isToday, plannedAll, cap); // no title bar in Plan my day / End day
    const cols = this.root.createDiv("samaya-daily-cols"); // everything else sits below the title bar
    const info = sd ? cols.createDiv("samaya-info") : null; // End day: the shutdown guide takes the first column; otherwise tasks and timeline, status lives in the heading (Plan my day: guide and tasks, the timeline is in the sidebar)
    const left = cols.createDiv("samaya-left");
    if (!pg) this.renderPane(cols.createDiv("samaya-today samaya-tlpane"), day, tlEvents, notes); // (plan my day: the timeline stays in the right sidebar)
    let body = left; // where today's planned list goes
    if (!pg) { // tasks heading: title, done count, progress
      const nd = day.filter(t => t.status === "done").length;
      left.addClass("is-sticky-head"); // the heading and its bar stay in view while the tasks scroll
      const head = left.createDiv("samaya-tasks-head");
      const row = head.createDiv("samaya-tasks-row");
      row.createEl("h3", { text: "Tasks" });
      const badge = row.createSpan({ cls: "samaya-tasks-count" + (day.length && nd === day.length ? " is-complete" : ""), text: day.length ? `${nd} / ${day.length} done` : "0" });
      renderDoneBar(head, nd, day.length, false);
      if (!sd && this.date >= today()) { // the quick add sits right under the bar and sticks with it
        const add = head.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: "+ Add task  (e.g. “Write report 1h”)" } });
        this.bindAdd(add, () => ({ planned: this.date, order: day.length }));
      }
      const all = day.length > 0 && nd === day.length;
      if (all && this.lastAll && this.lastAll.date === this.date && !this.lastAll.all) celebrate(badge); // right away: a delayed call can find the badge already replaced by the next re-render (the End day view re-renders several times per tick)
      this.lastAll = { date: this.date, all };
    }
    if (pg) {
      // columns: guide | source tasks (Review: left over, Pick: this week/backlog) | today's tasks
      const cols = left.createDiv("samaya-review-cols" + (step === 2 ? " is-two" : "") + (pick ? " is-pick" : ""));
      renderGuide(this.plugin, cols, { overdue: overdue.length, toSchedule: day.filter(t => !t.start).length, planned: day.length });
      if (check) { this.renderCheck(cols, day, cap, plannedAll); return void this.finishRender(left); }
      if (!review) this.lastOverdue = null;
      if (review) this.renderLeftOver(cols, overdue); else if (pick) this.renderPick(cols);
      body = cols.createDiv("samaya-plancol samaya-review-main");
      const todayBadge = this.colHead(body, "Today", day.length, review || pick ? "Drag tasks here, or press `Today` on a task." : "");
      if (step === 2) { // Timebox: the badge counts the tasks still waiting for a time slot
        const ns = day.filter(t => t.start).length; const allSet = day.length > 0 && ns === day.length;
        todayBadge.setText(`${day.length - ns} / ${day.length}`); todayBadge.toggleClass("is-complete", allSet); todayBadge.toggleClass("is-overdue", !allSet && ns < day.length); // orange while tasks still wait for a slot
        if (allSet && this.lastBoxed && this.lastBoxed.date === this.date && !this.lastBoxed.all) { todayBadge.addClass("is-pop"); celebrate(todayBadge); }
        this.lastBoxed = { date: this.date, all: allSet };
      } else this.lastBoxed = null;
      renderLoadBar(body, plannedAll, cap.free, `Free capacity = ${fmtDur(cap.total)} capacity - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`, bufferShare(s.bufferPercent), cap.meetings);
    }

    const list = body.createDiv("samaya-list" + (step === 2 ? " is-timebox" : ""));
    // Timebox: tasks with a time slot live on the timeline, so only the ones still waiting for a slot are listed
    const shown = step === 2 ? day.filter(t => !t.start) : day;
    if (!day.length) list.createDiv({ cls: "samaya-empty", text: "Nothing planned." });
    else if (!shown.length) list.createDiv({ cls: "samaya-empty samaya-allset", text: "Nothing left to schedule." });
    shown.forEach(t => {
      const idx = day.indexOf(t);
      const c = renderTaskCard(this.plugin, list, t, { scope: this.scope, showTime: true });
      c.toggleClass("is-timed", !!t.start);
      bindCardDrop(this.scope, c, (path, after, i) => { void this.place(path, idx + (after ? 1 : 0), i.fromTimeline); });
    });
    bindZone(this.scope, list, (path, i) => { void this.place(path, day.length, i.fromTimeline); });

    if (pg && !sd && !review && step !== 2 && this.date >= today()) { // (no quick add in Review and Timebox: go back to Pick to add tasks)
      const add = body.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: "+ Add task  (e.g. “Write report 1h”)" } });
      this.bindAdd(add, () => ({ planned: this.date, order: day.length }));
    }

    if (info) { renderGuide(this.plugin, info, { overdue: 0 }); info.scrollTop = this.infoScroll; }
    if (token !== this.token) return;
    this.finishRender(left);
  }

  /** The title bar, same design as the week heading: title, the day's status and capacity, then the actions, reset pill, ‹ 📅 ›, Day | Week. Everything else starts below it. */
  private renderHead(isToday: boolean, planned: number, cap: Capacity) {
    const h = this.root.createDiv("samaya-week-head samaya-day-head");
    renderHeadTitle(h, isToday ? "Today" : parseYmd(this.date).toLocaleDateString(undefined, { weekday: "long" }), dayHeadSub(this.date));
    const mid = h.createDiv("samaya-head-mid");
    const right = h.createDiv("samaya-planner-right");
    const slot = renderDayHeadStatus(this.plugin, mid, right, { date: this.date, planned, meetings: cap.meetings, free: cap.free, what: `Free capacity = ${fmtDur(cap.total)} capacity - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings` });
    if (!isToday) renderResetPill(slot, "Today", "Jump to today", this.date < today() ? "right" : "left", () => this.goTo(today()));
    renderDayNoteIcon(this.plugin, right, this.date);
    renderDateNav(right, {
      label: parseYmd(this.date).toLocaleDateString(undefined, { weekday: isToday ? "short" : undefined, month: "short", day: "numeric" }),
      prevLabel: "Previous day", nextLabel: "Next day", onPrev: () => this.goTo(addDays(this.date, -1)), onNext: () => this.goTo(addDays(this.date, 1)),
      pick: { value: this.date, label: "Pick a day", run: d => this.goTo(d) }, icon: "calendar",
    });
    renderModeSwitch(right, "day", { week: () => this.plugin.expandTimeline() });
    fitHead(h);
  }

  /** The timeline next to the task list: Day/Week switch, all-day events, then the hours. */
  private renderPane(pane: HTMLElement, day: Task[], events: IcsEvent[], notes: Map<IcsEvent, TFile>) {
    if (this.plugin.guide) pane.createDiv({ cls: "samaya-today-label", text: "Timeline" });
    const allDay = events.filter(e => e.allDay); // the same chips as the all-day events in the week timeline's day heads
    if (allDay.length) { const chips = pane.createDiv("samaya-tl-allday"); allDay.forEach(e => chips.createDiv({ cls: "samaya-wtl-chip is-event", text: e.title })); }
    this.tlHeight = renderTimeline(this.plugin, this.scope, pane, { date: this.date, day, events, notes, ro: false, state: this.tlState });
    if (!this.tlWatch) { // the hours stretch to the pane height
      this.tlWatch = new ResizeObserver(() => { const el = this.root.querySelector<HTMLElement>(".samaya-tlpane"); if (el && el.clientHeight !== this.tlHeight) this.schedule(); });
      this.tlWatch.observe(this.root); this.register(() => this.tlWatch?.disconnect());
    }
  }

  private finishRender(left: HTMLElement) {
    left.scrollTop = this.leftScroll;

    this.plugin.plannerGoTo = d => this.goTo(d); // "Open day" on other pages jumps here
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
    const badge = h.createSpan({ cls: "samaya-colhead-count", text: String(count) });
    if (hint) richText(host.createDiv("samaya-guide-text samaya-colhint"), hint);
    return badge;
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
    const add = col.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: this.pickTab === "week" ? "+ Add weekly task" : "+ Add to backlog" } });
    this.bindAdd(add, (): Record<string, string | number> => (this.pickTab === "week" ? { week: wk } : { horizon: "someday" }));
    const list = col.createDiv("samaya-leftover-list samaya-pick-list");
    if (this.pickTab === "week") {
      if (!tasks.length) list.createDiv({ cls: "samaya-empty", text: "Nothing planned for this week yet." });
      tasks.forEach(t => renderTaskCard(this.plugin, list, t, { scope: this.scope, actionsSide: true, actions: [["Today", () => { void placeInDay(this.app, s, t.file.path, this.date, 9999); }]] }));
      bindZone(this.scope, col, path => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) void patchTask(this.app, f, { planned: null, start: null, week: wk });
      });
    } else {
      renderBacklogBuckets(this.plugin, list, tasks, this.scope, { actionsSide: true, actions: t => [["Today", () => { void placeInDay(this.app, s, t.file.path, this.date, 9999); }]] }, { label: "samaya-colhead-count", list: "samaya-bucket-list", empty: "samaya-empty" });
    }
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

  /** Check step: a verdict on the day, its numbers, one bar (meetings, planned work, the 80% buffer line) and what is left to fix. */
  private renderCheck(host: HTMLElement, day: Task[], cap: Capacity, planned: number) {
    const g = this.plugin.guide; const go = (to: number) => { if (g) { g.step = to; this.plugin.bus.emit(); } };
    const share = bufferShare(this.plugin.settings.bufferPercent); const level = loadLevel(planned, cap.free, share); const pct0 = Math.round(share * 100);
    const open = day.filter(t => t.status !== "done");
    const noSlot = open.filter(t => !t.start); const noEst = open.filter(t => !t.estimate);
    const box = host.createDiv("samaya-chk samaya-chk-day-view");

    // ---- verdict
    const copy = !day.length ? ["An empty day", "Nothing is planned for today yet.", "inbox", "ok"]
      : level === "over" ? ["An overloaded day", `You planned ${fmtDur(planned - cap.free)} more than there is time for.`, "alert-octagon", "over"]
      : level === "tight" ? ["A full day", `You are ${fmtDur(trimToBuffer(planned, cap.free, share))} past the ${pct0}% buffer. Something will probably slip.`, "alert-triangle", "tight"]
      : ["A realistic day", "You keep room for the unexpected.", "check-circle-2", "ok"];
    const hero = box.createDiv(`samaya-chk-hero is-${copy[3]}`);
    setIcon(hero.createDiv("samaya-chk-hero-icon"), copy[2]);
    const ht = hero.createDiv("samaya-chk-hero-text");
    ht.createDiv({ cls: "samaya-chk-hero-title", text: copy[0] }); ht.createDiv({ cls: "samaya-chk-hero-sub", text: copy[1] });
    ht.createDiv({ cls: "samaya-chk-hero-count", text: `${day.length} ${day.length === 1 ? "task" : "tasks"} · ${day.length - noSlot.length} scheduled${noSlot.length ? ` · ${noSlot.length} without a time slot` : ""}` });

    // ---- the day in numbers
    const stats = box.createDiv("samaya-chk-stats");
    const stat = (label: string, value: string, sub: string, cls: string) => { const t = stats.createDiv("samaya-chk-stat " + cls); t.createDiv({ cls: "samaya-chk-stat-label", text: label }); t.createDiv({ cls: "samaya-chk-stat-value", text: value }); t.createDiv({ cls: "samaya-chk-stat-sub", text: sub }); };
    stat("Tasks", fmtDur(planned), `${day.length} planned · ${fmtDur(Math.round(cap.free * share))} recommended`, `is-tasks is-${level}`);
    stat("Meetings", fmtDur(cap.meetings), cap.meetings ? "from your calendar" : "none today", "is-meet");
    stat("Unplanned time", fmtDur(Math.max(0, cap.free - planned)), "no meetings or tasks", "is-open");

    // ---- the working day as one bar
    box.createDiv({ cls: "samaya-chk-h", text: "Your day" });
    const avail = cap.free + cap.meetings; // the workday without lunch
    const bar = box.createDiv("samaya-chk-hbar" + (avail > 0 ? "" : " is-off"));
    if (avail > 0) {
      const pct = (m: number) => `${Math.min(100, Math.max(0, (m / avail) * 100))}%`;
      const meet = bar.createDiv("samaya-chk-hseg is-meet"); meet.style.width = pct(cap.meetings);
      const work = bar.createDiv(`samaya-chk-hseg is-work is-${level}`); work.style.left = pct(cap.meetings); work.style.width = pct(Math.min(planned, cap.free + (planned > cap.free ? cap.meetings : 0)));
      const line = bar.createDiv("samaya-chk-hline"); line.style.left = pct(cap.meetings + cap.free * share); line.title = `${pct0}% of the free time`;
    }
    const legend = box.createDiv("samaya-chk-legend");
    for (const [cls, text] of [["is-meet", "Meetings"], ["is-work", "Tasks"], ["is-open", "Unplanned"], ["is-line", `${pct0}% line`]]) { const l = legend.createSpan("samaya-chk-legend-item"); l.createSpan({ cls: `samaya-chk-swatch ${cls}` }); l.createSpan({ text }); }

    // ---- what is left to fix
    const todo: Array<{ title: string; text: string; label: string; step: number }> = [];
    if (level !== "ok") todo.push({ title: "Lighten today", text: `Take about ${fmtDur(trimToBuffer(planned, cap.free, share))} off: send a task back to This week or the Backlog.`, label: "Back to Pick", step: 1 });
    if (noSlot.length) todo.push({ title: `${noSlot.length} ${noSlot.length === 1 ? "task has" : "tasks have"} no time slot`, text: `${noSlot.slice(0, 3).map(t => t.title).join(", ")}${noSlot.length > 3 ? ` and ${noSlot.length - 3} more` : ""}. Drag ${noSlot.length === 1 ? "it" : "them"} onto the timeline.`, label: "Back to Timebox", step: 2 });
    if (noEst.length) todo.push({ title: `${noEst.length} ${noEst.length === 1 ? "task has" : "tasks have"} no estimate`, text: `${noEst.slice(0, 3).map(t => t.title).join(", ")}${noEst.length > 3 ? ` and ${noEst.length - 3} more` : ""}. Without one the day looks emptier than it is.`, label: "Back to Timebox", step: 2 });
    const fix = box.createDiv("samaya-chk-fix" + (todo.length ? "" : " is-clear"));
    if (!todo.length) { setIcon(fix.createDiv("samaya-chk-fix-icon"), "check"); fix.createDiv({ cls: "samaya-chk-fix-title", text: `Nothing left to fix. Press ${this.plugin.workday.started ? "Finalize plan" : "Start my day"} when you are ready.` }); }
    else {
      fix.createDiv({ cls: "samaya-chk-fix-head", text: "Before you start" });
      for (const it of todo) {
        const row = fix.createDiv("samaya-chk-fix-item"); const t = row.createDiv("samaya-chk-fix-text");
        t.createDiv({ cls: "samaya-chk-fix-title", text: it.title }); t.createDiv({ cls: "samaya-chk-fix-sub", text: it.text });
        row.createEl("button", { cls: "samaya-chk-fix-btn", text: it.label }).onclick = () => go(it.step);
      }
    }
  }

  private renderLeftOver(host: HTMLElement, overdue: Task[]) {
    const col = host.createDiv("samaya-plancol samaya-leftover");
    const badge = this.colHead(col, "Overdue", overdue.length, "Press one of the buttons to schedule a task, or drag the task directly into today's list on the right.");
    badge.toggleClass("is-overdue", overdue.length > 0); // orange only while something is overdue
    if (!overdue.length && this.lastOverdue) { badge.addClass("is-pop"); celebrate(badge); } // the moment the last one is sorted out
    this.lastOverdue = overdue.length;
    const list = col.createDiv("samaya-leftover-list");
    if (!overdue.length) list.createDiv({ cls: "samaya-empty samaya-allset", text: "Nothing overdue." });
    const tomorrow = addDays(today(), 1);
    overdue.forEach(t => renderTaskCard(this.plugin, list, t, {
      scope: this.scope,
      actions: [
        ["Today", () => { void patchTask(this.app, t.file, { planned: today(), start: null }); }],
        ["Tomorrow", () => { void patchTask(this.app, t.file, { planned: tomorrow, start: null }); }],
        ["This week", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: startOfWeek(today()) }); }],
        ["Backlog", () => { void parkTask(this.app, t.file, "someday"); }],
      ],
    }));
  }

  private fileOf(path: string): TFile { return this.app.vault.getAbstractFileByPath(path) as TFile; }
}
