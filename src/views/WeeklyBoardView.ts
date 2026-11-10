import { BasesView, Notice, QueryController, TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, allTasks, createTask, parkTask, patchTask, placeInDay, prefixOf, readTask, setDone, sortTasks } from "../model";
import type { IcsEvent } from "../ics";
import { BUFFER_SHARE, isLeftover, loadLevel } from "../weekplan";
import { renderGuide } from "./guide";
import { renderBacklogBuckets, richText } from "./common";
import { addDays, fmtDur, minToHm, parseTitleEstimate, parseYmd, startOfWeek, today } from "../util";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { Capacity, capacityWindow } from "../worktime";
import { bindCardDrop, bindZone, renderTaskCard } from "./common";

export const WEEK_VIEW_TYPE = "samaya-week";

export class WeeklyBoardView extends BasesView {
  readonly type = WEEK_VIEW_TYPE;
  private root: HTMLElement;
  private weekStart = startOfWeek(today());
  private scope = new DndScope();
  private pending = false;
  private timer = 0;
  private token = 0;

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    this.root = parentEl.createDiv("samaya-week");
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
    this.register(plugin.bus.on(() => this.schedule()));
    const ref = plugin.app.metadataCache.on("changed", f => { if (!this.plugin.guide) return; if (inEventFolder(plugin.settings, f.path) || f.path.startsWith(prefixOf(plugin.settings.tasksPath))) this.schedule(); });
    this.register(() => plugin.app.metadataCache.offref(ref));
    if (plugin.guide?.kind !== "week") void this.plugin.openToday(); // the sidebar shows the week's unscheduled tasks while the board is open (the week guide hides it)
  }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); if (this.plugin.boardWeek === this.weekStart) { this.plugin.boardWeek = ""; this.plugin.modeBus.emit(); } }
  onDataUpdated(): void { this.schedule(); }
  private schedule() {
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render(); }, 30);
  }

  private async render() {
    const token = ++this.token; const s = this.plugin.settings;
    const weekends = this.config.get("showWeekends") === true;
    const from = parseYmd(this.weekStart);
    const events = calendarEnabled(s) ? (await calendarEvents(this.plugin, from, parseYmd(addDays(this.weekStart, 7))).catch(() => [])).filter(e => !e.allDay) : [];
    if (token !== this.token) return;
    if (this.scope.active) { this.pending = true; return; }
    const wg = this.plugin.guide?.kind === "week" ? this.plugin.guide : null;
    if (wg?.fresh) { wg.fresh = false; this.weekStart = wg.week ?? this.weekStart; }
    if (wg) { await this.renderGuided(wg.step, from); return; }
    this.root.removeClass("is-guided");
    const all = this.data.data.map(e => readTask(this.app, e.file));
    const scrollX = this.root.scrollLeft; const scrollY = this.root.scrollTop;
    this.root.empty(); this.scope.clear();

    if (this.plugin.boardWeek !== this.weekStart) { this.plugin.boardWeek = this.weekStart; this.plugin.modeBus.emit(); }
    const head = this.root.createDiv("samaya-week-head");
    const go = (w: string) => { this.weekStart = w; void this.render(); };
    head.createEl("button", { text: "‹" }).onclick = () => go(addDays(this.weekStart, -7));
    head.createEl("button", { text: "This week" }).onclick = () => go(startOfWeek(today()));
    head.createEl("button", { text: "›" }).onclick = () => go(addDays(this.weekStart, 7));
    const fmt = (s: string) => parseYmd(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    head.createEl("h2", { text: `${fmt(this.weekStart)} – ${fmt(addDays(this.weekStart, 6))}` });

    const cols2 = this.root.createDiv("samaya-cols");
    for (let i = 0; i < (weekends ? 7 : 5); i++) {
      const date = addDays(this.weekStart, i); const dayMs = parseYmd(date).getTime();
      const cap = capacityWindow(...this.plugin.workWindowFor(date), this.plugin.lunchFor(date),
        events.map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]));
      this.column(cols2, parseYmd(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }), "day", date, sortTasks(all.filter(t => t.planned === date)), date === today(), cap);
    }
    this.root.scrollLeft = scrollX; this.root.scrollTop = scrollY;
  }

  private column(parent: HTMLElement, title: string, kind: "day", key: string, tasks: Task[], isToday: boolean, cap: Capacity) {
    const col = parent.createDiv({ cls: "samaya-col" + (isToday ? " is-today" : "") });
    const h = col.createDiv("samaya-col-head");
    h.createSpan({ cls: "samaya-col-title", text: title });
    const planned = tasks.reduce((a, t) => a + (t.estimate || 0), 0);
    const bar = col.createDiv({ cls: "samaya-col-bar" + (planned > cap.free ? " is-over" : "") });
    bar.createDiv("samaya-col-bar-fill").style.width = `${planned > cap.free || cap.free <= 0 ? (planned > 0 ? 100 : 0) : (planned / cap.free) * 100}%`;
    const sum = h.createSpan({ cls: "samaya-col-cap" + (planned > cap.free ? " is-over" : ""), text: `${fmtDur(planned)}/${fmtDur(cap.free)}` });
    sum.title = `Free to plan = ${fmtDur(cap.total)} work time - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`;
    const add = col.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: "+ Add task" } });
    add.addEventListener("keydown", e => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      const p = parseTitleEstimate(add.value); add.value = "";
      void createTask(this.app, this.plugin.settings, p.title, { planned: key, estimate: p.estimate ?? this.plugin.settings.defaultEstimate, order: tasks.length });
    });
    const body = col.createDiv("samaya-col-body");
    tasks.forEach((t, idx) => {
      const c = renderTaskCard(this.plugin, body, t, { scope: this.scope, showTime: true });
      bindCardDrop(this.scope, c, (path, after) => { void placeInDay(this.app, this.plugin.settings, path, key, idx + (after ? 1 : 0)); });
    });
    bindZone(this.scope, col, path => { void placeInDay(this.app, this.plugin.settings, path, key, tasks.length); });
  }

  // ---------------------------------------------------------------- Plan my week

  private capOf(date: string, events: IcsEvent[]): Capacity {
    const dayMs = parseYmd(date).getTime();
    return capacityWindow(...this.plugin.workWindowFor(date), this.plugin.lunchFor(date),
      events.filter(e => !e.allDay).map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]));
  }

  /** The guided layout: the guide on the left, the step's columns next to it. Reads the vault directly, so new tasks show up at once. */
  private async renderGuided(step: number, from: Date) {
    const s = this.plugin.settings; const wk = this.weekStart; const td = today();
    const weekends = this.config.get("showWeekends") === true;
    const days = Array.from({ length: weekends ? 7 : 5 }, (_, i) => addDays(wk, i));
    const events = calendarEnabled(s) ? await calendarEvents(this.plugin, from, parseYmd(addDays(wk, 7))).catch(() => [] as IcsEvent[]) : [];
    if (this.scope.active) { this.pending = true; return; }
    const keep = new Map<string, number>(); this.root.querySelectorAll<HTMLElement>("[data-scroll]").forEach(e => keep.set(e.dataset.scroll!, e.scrollTop));
    this.root.empty(); this.scope.clear(); this.root.addClass("is-guided");
    if (this.plugin.boardWeek !== wk) { this.plugin.boardWeek = wk; this.plugin.modeBus.emit(); }

    const all = allTasks(this.app, s);
    const open = all.filter(t => t.status !== "done");
    const inWeek = (t: Task) => (t.planned ? t.planned >= wk && t.planned < addDays(wk, 7) : t.week === wk);
    const weekTasks = open.filter(inWeek);
    const noDay = sortTasks(weekTasks.filter(t => !t.planned));
    const leftovers = sortTasks(open.filter(t => isLeftover(t, td, wk)));
    const caps = new Map(days.map(d => [d, this.capOf(d, events.filter(e => e.end.getTime() > parseYmd(d).getTime() && e.start.getTime() < parseYmd(addDays(d, 1)).getTime()))]));
    const freeTotal = [...caps.values()].reduce((a, c) => a + c.free, 0);
    const plannedTotal = weekTasks.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0);

    const grid = this.root.createDiv("samaya-wg");
    renderGuide(this.plugin, grid, { overdue: leftovers.length });
    const main = grid.createDiv("samaya-wg-main");
    const scroller = (host: HTMLElement, key: string, cls = "") => { const el = host.createDiv("samaya-wg-scroll " + cls); el.dataset.scroll = key; return el; };
    const toWeek = (path: string) => { const f = this.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) void patchTask(this.app, f, { planned: null, start: null, week: wk }); };
    const head = (col: HTMLElement, title: string, count: number, hint: string) => {
      const h = col.createDiv("samaya-colhead"); h.createSpan({ cls: "samaya-colhead-title", text: title }); h.createSpan({ cls: "samaya-colhead-count", text: String(count) });
      richText(col.createDiv("samaya-guide-text samaya-colhint"), hint);
    };
    const addBox = (col: HTMLElement, placeholder: string, props: () => Record<string, string | number>) => {
      const add = col.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder } });
      add.addEventListener("keydown", e => {
        if (e.key !== "Enter" || e.isComposing || !add.value.trim()) return;
        const p = parseTitleEstimate(add.value); add.value = "";
        createTask(this.app, s, p.title, { ...props(), estimate: p.estimate ?? s.defaultEstimate })
          .then(() => { window.setTimeout(() => this.schedule(), 250); })
          .catch((err: unknown) => { new Notice(`Samaya: could not create the task (${err instanceof Error ? err.message : String(err)})`); });
      });
    };
    /** planned vs 80% of the free time, with a bar that turns orange past the buffer and red past the capacity */
    const weekLoad = (col: HTMLElement) => {
      const lvl = loadLevel(plannedTotal, freeTotal);
      const box = col.createDiv({ cls: `samaya-loadbar is-${lvl}` });
      const budget = Math.round(freeTotal * BUFFER_SHARE);
      const label = box.createDiv({ cls: "samaya-total", text: `${fmtDur(plannedTotal)} planned · ${fmtDur(budget)} recommended` });
      label.title = `Free time of the week = work time - lunch - meetings = ${fmtDur(freeTotal)}. Plan at most ${Math.round(BUFFER_SHARE * 100)}% of it (${fmtDur(budget)}).`;
      const bar = box.createDiv({ cls: `samaya-col-bar is-${lvl}` });
      bar.createDiv("samaya-col-bar-fill").style.width = `${freeTotal <= 0 ? (plannedTotal > 0 ? 100 : 0) : Math.min(100, (plannedTotal / freeTotal) * 100)}%`;
    };
    const weekCol = (host: HTMLElement) => {
      const col = host.createDiv("samaya-plancol samaya-wg-col");
      const shown = [...noDay, ...sortTasks(weekTasks.filter(t => t.planned)).sort((a, b) => a.planned.localeCompare(b.planned))];
      head(col, "This week", shown.length, "Press `This week` on a task, or drag it here. Tasks that already have a day show it above the card.");
      weekLoad(col);
      const list = scroller(col, "week", "samaya-leftover-list");
      if (!shown.length) list.createDiv({ cls: "samaya-empty", text: "Nothing planned for this week yet." });
      shown.forEach(t => {
        if (t.planned) list.createDiv({ cls: "samaya-week-day", text: parseYmd(t.planned).toLocaleDateString(undefined, { weekday: "long", day: "numeric" }) });
        renderTaskCard(this.plugin, list, t, { scope: this.scope, compact: step === 2 });
      });
      bindZone(this.scope, col, toWeek);
      addBox(col, "+ Add weekly task", () => ({ week: wk }));
    };

    if (step === 0) {
      const cols = main.createDiv("samaya-wg-cols");
      const col = cols.createDiv("samaya-plancol samaya-wg-col");
      head(col, "Left over", leftovers.length, "Decide for each task what happens to it.");
      const list = scroller(col, "left", "samaya-leftover-list");
      if (!leftovers.length) list.createDiv({ cls: "samaya-empty", text: "Nothing left over." });
      leftovers.forEach(t => renderTaskCard(this.plugin, list, t, { scope: this.scope, actions: [
        ["This week", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: wk }); }],
        ["Backlog", () => { void parkTask(this.app, t.file, "someday"); }],
        ["Done", () => { void setDone(this.app, t, true); }],
      ] }));
      weekCol(cols);
    } else if (step === 1) {
      const cols = main.createDiv("samaya-wg-cols");
      const col = cols.createDiv("samaya-plancol samaya-wg-col");
      head(col, "Backlog", 0, "Press `This week` on a task, or drag it into the week.");
      const bl = open.filter(t => !t.planned && t.week !== wk && !leftovers.includes(t));
      (col.querySelector(".samaya-colhead-count") as HTMLElement).setText(String(bl.length));
      const list = scroller(col, "backlog");
      renderBacklogBuckets(this.plugin, list, sortTasks(bl), this.scope, { actionsSide: true, actions: t => [["This week", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: wk }); }]] }, { label: "samaya-colhead-count", list: "samaya-bucket-list", empty: "samaya-empty" });
      addBox(col, "+ Add to backlog", () => ({ horizon: "someday" }));
      weekCol(cols);
    } else if (step === 2) {
      const cols = main.createDiv("samaya-wg-cols is-schedule");
      weekCol(cols);
      const board = scroller(cols, "board", "samaya-wg-board");
      days.forEach(date => this.guidedDay(board, date, caps.get(date)!, events, sortTasks(open.filter(t => t.planned === date)), date === td));
    } else {
      this.renderCheck(main, days, caps, open, noDay, plannedTotal, freeTotal);
    }
    keep.forEach((v, k) => { const e = this.root.querySelector<HTMLElement>(`[data-scroll="${k}"]`); if (e) e.scrollTop = v; });
  }

  /** One day of the Schedule step: its meetings as a compact agenda on top, then the load bar and the day's tasks. */
  private guidedDay(parent: HTMLElement, date: string, cap: Capacity, events: IcsEvent[], tasks: Task[], isToday: boolean) {
    const s = this.plugin.settings; const dayMs = parseYmd(date).getTime();
    const col = parent.createDiv({ cls: "samaya-col samaya-wg-day" + (isToday ? " is-today" : "") });
    const planned = tasks.reduce((a, t) => a + (t.estimate || 0), 0); const lvl = loadLevel(planned, cap.free);
    const h = col.createDiv("samaya-col-head");
    h.createSpan({ cls: "samaya-col-title", text: parseYmd(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) });
    const sum = h.createSpan({ cls: `samaya-col-cap is-${lvl}`, text: `${fmtDur(planned)}/${fmtDur(cap.free)}` });
    sum.title = `Free to plan = ${fmtDur(cap.total)} work time - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings. Keep about ${Math.round((1 - BUFFER_SHARE) * 100)}% of it free.`;
    const bar = col.createDiv({ cls: `samaya-col-bar is-${lvl}` });
    bar.createDiv("samaya-col-bar-fill").style.width = `${cap.free <= 0 ? (planned > 0 ? 100 : 0) : Math.min(100, (planned / cap.free) * 100)}%`;
    const evs = events.filter(e => e.end.getTime() > dayMs && e.start.getTime() < dayMs + 86400000).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
    const ag = col.createDiv("samaya-agenda");
    if (!evs.length) ag.createDiv({ cls: "samaya-agenda-empty", text: "No meetings" });
    evs.forEach(e => {
      const r = ag.createDiv({ cls: "samaya-agenda-row" + (e.allDay ? " is-allday" : ""), attr: { title: e.title } });
      r.createSpan({ cls: "samaya-agenda-time", text: e.allDay ? "all day" : minToHm(Math.max(0, (e.start.getTime() - dayMs) / 60000)) });
      r.createSpan({ cls: "samaya-agenda-title", text: e.title });
    });
    const body = col.createDiv("samaya-col-body");
    tasks.forEach((t, idx) => {
      const c = renderTaskCard(this.plugin, body, t, { scope: this.scope, showTime: true, compact: true });
      bindCardDrop(this.scope, c, (path, after) => { void placeInDay(this.app, s, path, date, idx + (after ? 1 : 0)); });
    });
    bindZone(this.scope, col, path => { void placeInDay(this.app, s, path, date, tasks.length); });
  }

  /** Check step: every day against its free time, what still has no day, and the week as a whole. */
  private renderCheck(main: HTMLElement, days: string[], caps: Map<string, Capacity>, open: Task[], noDay: Task[], plannedTotal: number, freeTotal: number) {
    const box = main.createDiv("samaya-wg-check");
    box.createEl("h3", { text: "The week at a glance" });
    let warn = 0;
    const rows = box.createDiv("samaya-wg-rows");
    days.forEach(date => {
      const cap = caps.get(date)!; const planned = open.filter(t => t.planned === date).reduce((a, t) => a + (t.estimate || 0), 0);
      const lvl = loadLevel(planned, cap.free); if (lvl !== "ok") warn++;
      const r = rows.createDiv("samaya-wg-row");
      r.createSpan({ cls: "samaya-wg-rowday", text: parseYmd(date).toLocaleDateString(undefined, { weekday: "long", day: "numeric" }) });
      const bar = r.createDiv({ cls: `samaya-col-bar is-${lvl}` });
      bar.createDiv("samaya-col-bar-fill").style.width = `${cap.free <= 0 ? (planned > 0 ? 100 : 0) : Math.min(100, (planned / cap.free) * 100)}%`;
      r.createSpan({ cls: "samaya-wg-rownum", text: `${fmtDur(planned)} / ${fmtDur(cap.free)}` });
      r.createSpan({ cls: `samaya-wg-rowflag is-${lvl}`, text: lvl === "over" ? "Over capacity" : lvl === "tight" ? `Past ${Math.round(BUFFER_SHARE * 100)}%` : "Room left" });
    });
    const lines: Array<[string, string]> = [];
    if (warn) lines.push(["alert", `${warn} ${warn === 1 ? "day is" : "days are"} past the ${Math.round(BUFFER_SHARE * 100)}% buffer. Move something to a lighter day or back to the backlog.`]);
    if (noDay.length) lines.push(["alert", `${noDay.length} ${noDay.length === 1 ? "task has" : "tasks have"} no day yet: ${noDay.slice(0, 4).map(t => t.title).join(", ")}${noDay.length > 4 ? "…" : ""}. Give ${noDay.length === 1 ? "it" : "them"} a day, or that is fine as a pool to draw from.`]);
    if (!warn && !noDay.length) lines.push(["check", "This looks realistic."]);
    lines.push(["life-buoy", `Week: ${fmtDur(plannedTotal)} planned of ${fmtDur(freeTotal)} free. Things will come up. If everything fits perfectly on paper, it will not fit in real life.`]);
    const notes = box.createDiv("samaya-wg-notes");
    lines.forEach(([icon, text]) => { const n = notes.createDiv("samaya-wg-note"); setIcon(n.createSpan("samaya-wg-note-icon"), icon); n.createSpan({ text }); });
  }
}
