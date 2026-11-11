import type { PlannerHost } from "./plannerHost";
import { BasesView, Notice, QueryController, TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, Ticket, allTasks, allTickets, ticketPathOf, createTask, parkTask, patchTask, placeInDay, prefixOf, readTask, sortTasks } from "../model";
import type { IcsEvent } from "../ics";
import { bufferShare, isLeftover, loadLevel, trimToBuffer, weekVerdict } from "../weekplan";
import { renderGuide } from "./guide";
import { celebrate } from "./doneBar";
import { addTaskInput, capacityOf, weekBuckets } from "./weekColumn";
import { TicketTaskModal } from "../modals";
import { groupTickets, statusRank } from "../kanban";
import { HORIZONS, addDays, bucketOf, fmtDur, horizonTarget, minToHm, parseTitleEstimate, parseYmd, startOfWeek, today } from "../util";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { Capacity, capacityWindow } from "../worktime";
import { bindCardDrop, bindZone, renderTaskCard, richText } from "./common";

export const WEEK_VIEW_TYPE = "samaya-week";

export class WeeklyBoardView extends BasesView {
  readonly type = WEEK_VIEW_TYPE;
  private root: HTMLElement;
  private weekStart = startOfWeek(today());
  private scope = new DndScope();
  private pending = false;
  private timer = 0;
  private token = 0;
  private kbCollapsed = new Set<string>();
  private kbX = 0;
  private lastLeft: number | null = null; // Overdue step: to spot the moment the last overdue task gets sorted out

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin, private host?: PlannerHost) {
    super(controller);
    this.root = parentEl.createDiv("samaya-week");
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
    this.register(plugin.bus.on(() => this.schedule()));
    const ref = plugin.app.metadataCache.on("changed", f => { if (!this.plugin.guide) return; if (inEventFolder(plugin.settings, f.path) || f.path.startsWith(prefixOf(plugin.settings.tasksPath))) this.schedule(); });
    this.register(() => plugin.app.metadataCache.offref(ref));
    void this.plugin.openToday(); // the sidebar shows the week's tasks while the board is open
  }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); if (this.plugin.boardWeek === this.weekStart) { this.plugin.boardWeek = ""; this.plugin.modeBus.emit(); } }
  onDataUpdated(): void { this.schedule(); }
  refresh() { this.schedule(); }
  getWeek() { return this.weekStart; }
  /** Planner: show the week that contains `date`. */
  showWeekOf(date: string) { this.weekStart = startOfWeek(date); this.schedule(); }
  private schedule() {
    if (this.host?.hidden()) return; // the Day pane is showing
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
    const wg = this.host && this.plugin.guide?.kind === "week" ? this.plugin.guide : null; // the guide runs in the Planner; the standalone board stays a board
    if (wg?.fresh) { wg.fresh = false; this.weekStart = wg.week ?? this.weekStart; }
    if (wg) { await this.renderGuided(wg.step, from); return; }
    this.root.removeClass("is-guided");
    const all = this.data.data.map(e => readTask(this.app, e.file));
    const scrollX = this.root.scrollLeft; const scrollY = this.root.scrollTop;
    this.root.empty(); this.scope.clear(); this.root.toggleClass("is-aligned", !!this.host?.aligned?.()); // expanded week: the day columns line up with the timeline's, in every layout

    if (this.plugin.boardWeek !== this.weekStart) { this.plugin.boardWeek = this.weekStart; this.plugin.modeBus.emit(); }
    let head: HTMLElement | null = null;
    {
      head = this.root.createDiv("samaya-week-head");
      const go = (w: string) => { if (this.host?.weekChanged) this.host.weekChanged(w); else { this.weekStart = w; void this.render(); } };
      head.createEl("button", { text: "‹" }).onclick = () => go(addDays(this.weekStart, -7));
      head.createEl("button", { text: "This week" }).onclick = () => go(startOfWeek(today()));
      head.createEl("button", { text: "›" }).onclick = () => go(addDays(this.weekStart, 7));
      const fmt = (s: string) => parseYmd(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      head.createEl("h2", { text: `${fmt(this.weekStart)} – ${fmt(addDays(this.weekStart, 6))}` });
      if (this.host?.back) { // same Day | Week switch as on the timeline
        const sw = head.createDiv("samaya-modeswitch is-right");
        sw.createEl("button", { text: "Day", attr: { title: "Back to the day planner (Esc)" } }).onclick = () => this.host?.back?.();
        sw.createEl("button", { text: "Week", cls: "is-active" });
      }
    }

    this.host?.placeBar?.(this.root, head);
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
    { // (expanded week, under the timeline: CSS hides the heading and bar, the day is already named above)
      const h = col.createDiv("samaya-col-head");
      h.createSpan({ cls: "samaya-col-title", text: title });
      const planned = tasks.reduce((a, t) => a + (t.estimate || 0), 0);
      const bar = col.createDiv({ cls: "samaya-col-bar" + (planned > cap.free ? " is-over" : "") });
      bar.createDiv("samaya-col-bar-fill").style.width = `${planned > cap.free || cap.free <= 0 ? (planned > 0 ? 100 : 0) : (planned / cap.free) * 100}%`;
      const sum = h.createSpan({ cls: "samaya-col-cap" + (planned > cap.free ? " is-over" : ""), text: `${fmtDur(planned)}/${fmtDur(cap.free)}` });
      sum.title = `Free to plan = ${fmtDur(cap.total)} work time - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`;
    }
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

  /** The guided layout: the guide on the left, the step's columns next to it. Reads the vault directly, so new tasks show up at once. */
  private async renderGuided(step: number, from: Date) {
    const s = this.plugin.settings; const wk = this.weekStart; const td = today();
    const weekends = this.config.get("showWeekends") === true;
    const days = Array.from({ length: weekends ? 7 : 5 }, (_, i) => addDays(wk, i));
    const events = calendarEnabled(s) ? await calendarEvents(this.plugin, from, parseYmd(addDays(wk, 7))).catch(() => [] as IcsEvent[]) : [];
    if (this.scope.active) { this.pending = true; return; }
    const g = this.plugin.guide; if (g && g.days !== days.length) { g.days = days.length; window.setTimeout(() => this.plugin.bus.emit(), 0); } // the sidebar needs to know how many days count
    const keep = new Map<string, number>(); this.root.querySelectorAll<HTMLElement>("[data-scroll]").forEach(e => { keep.set(e.dataset.scroll!, e.scrollTop); if (e.dataset.scroll === "kb") this.kbX = e.scrollLeft; });
    this.root.empty(); this.scope.clear(); this.root.addClass("is-guided");
    if (this.plugin.boardWeek !== wk) { this.plugin.boardWeek = wk; this.plugin.modeBus.emit(); }

    const all = allTasks(this.app, s);
    const open = all.filter(t => t.status !== "done");
    const { weekTasks, noDay } = weekBuckets(all, wk); // done tasks stay: they used up time and are worth seeing
    const leftovers = sortTasks(open.filter(t => isLeftover(t, td, wk)));
    const caps = new Map(days.map(d => [d, capacityOf(this.plugin, d, events)]));
    const freeTotal = [...caps.values()].reduce((a, c) => a + c.free, 0);
    const plannedTotal = weekTasks.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0);

    const grid = this.root.createDiv("samaya-wg");
    renderGuide(this.plugin, grid, { overdue: leftovers.length });
    const main = grid.createDiv("samaya-wg-main");
    const scroller = (host: HTMLElement, key: string, cls = "") => { const el = host.createDiv("samaya-wg-scroll " + cls); el.dataset.scroll = key; return el; };
    const head = (col: HTMLElement, title: string, count: number, hint?: string) => {
      const h = col.createDiv("samaya-colhead"); h.createSpan({ cls: "samaya-colhead-title", text: title }); const badge = h.createSpan({ cls: "samaya-colhead-count", text: String(count) });
      if (hint) richText(col.createDiv("samaya-guide-text samaya-colhint"), hint);
      return badge;
    };
    if (step !== 0) this.lastLeft = null;
    const addBox = (col: HTMLElement, placeholder: string, props: () => Record<string, string | number>) => { addTaskInput(this.plugin, col, placeholder, props, () => this.schedule()); };

    if (step === 0) {
      const cols = main.createDiv("samaya-wg-cols is-board is-review"); // the Overdue column sits at the right, next to the sidebar with This week
      const col = cols.createDiv("samaya-plancol samaya-wg-col");
      const badge = head(col, "Overdue", leftovers.length, "Decide for each task what happens to it.");
      badge.toggleClass("is-overdue", leftovers.length > 0); // orange only while something is overdue
      if (!leftovers.length && this.lastLeft) { badge.addClass("is-pop"); celebrate(badge); } // the moment the last one is sorted out
      this.lastLeft = leftovers.length;
      const list = scroller(col, "left", "samaya-leftover-list");
      if (!leftovers.length) list.createDiv({ cls: "samaya-empty samaya-allset", text: "Nothing overdue." });
      leftovers.forEach(t => renderTaskCard(this.plugin, list, t, { scope: this.scope, actions: [
        ["This week", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: wk }); }],
        ["Backlog", () => { void parkTask(this.app, t.file, "someday"); }],
      ] }));
    } else if (step === 1) {
      // the ticket board scrolls on its own; This week is in the right sidebar, so new tasks are always in sight
      const cols = main.createDiv("samaya-wg-cols is-board");
      const tickets = allTickets(this.app, s).filter(tk => statusRank(tk.state) < 3);
      const area = cols.createDiv("samaya-plancol samaya-wg-col");
      head(area, "Tickets", tickets.length, "Press `New task` on a ticket to plan work for it.");
      const sc = scroller(area, "kb", "samaya-wg-kb");
      if (!tickets.length) sc.createDiv({ cls: "samaya-empty", text: "No open tickets." });
      const { columns, lanes } = groupTickets(tickets);
      if (tickets.length) {
        const grid = sc.createDiv("samaya-kb-grid"); grid.style.setProperty("--cols", String(columns.length));
        const hd = grid.createDiv("samaya-kb-cols");
        for (const c of columns) hd.createDiv({ cls: "samaya-kb-colhead", text: `${c} (${tickets.filter(t => (t.state || "No status") === c).length})` });
        for (const lane of lanes) {
          const box = grid.createDiv("samaya-kb-lane"); const closed = this.kbCollapsed.has(lane.project);
          const title = box.createDiv({ cls: "samaya-kb-lanehead" + (closed ? " is-collapsed" : "") });
          title.createSpan({ cls: "samaya-kb-chevron", text: "▾" }); title.createSpan({ text: lane.project }); title.createSpan({ cls: "samaya-kb-count", text: String(lane.count) });
          title.onclick = () => { if (!this.kbCollapsed.delete(lane.project)) this.kbCollapsed.add(lane.project); this.schedule(); };
          if (closed) continue;
          const row = box.createDiv("samaya-kb-row");
          for (const c of columns) {
            const cell = row.createDiv("samaya-kb-cell");
            for (const tk of lane.cells.get(c) ?? []) this.ticketCard(cell, tk, all.filter(t => ticketPathOf(this.app, t) === tk.file.path), wk);
          }
        }
      }
    } else if (step === 2) {
      // same layout as the Tickets step: a board of the backlog categories, with This week in the sidebar
      const cols = main.createDiv("samaya-wg-cols is-board");
      const bl = sortTasks(open.filter(t => !t.planned && t.week !== wk && !leftovers.includes(t)));
      const area = cols.createDiv("samaya-plancol samaya-wg-col");
      head(area, "Backlog", bl.length, "Press `This week` on a task, or drag it into the week or between the categories.");
      const sc = scroller(area, "kb", "samaya-wg-kb");
      const grid = sc.createDiv("samaya-kb-grid"); grid.style.setProperty("--cols", String(HORIZONS.length));
      const hd = grid.createDiv("samaya-kb-cols"); const row = grid.createDiv("samaya-kb-row");
      for (const [h, label] of HORIZONS) {
        const ts = bl.filter(t => bucketOf(t.horizon, t.later, td) === h);
        hd.createDiv({ cls: "samaya-kb-colhead", text: `${label} (${ts.length})` });
        const cell = row.createDiv("samaya-kb-cell");
        bindZone(this.scope, cell, path => { const f = this.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) void parkTask(this.app, f, h); });
        addBox(cell, "+ Add task", () => ({ horizon: h, ...(horizonTarget(h, td) ? { later: horizonTarget(h, td) } : {}) }));
        ts.forEach(t => renderTaskCard(this.plugin, cell, t, { scope: this.scope, compact: true, actions: [["This week", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: wk }); }]] }));
      }
    } else if (step === 3) {
      const cols = main.createDiv("samaya-wg-cols is-schedule");
      const board = scroller(cols, "board", "samaya-wg-board");
      days.forEach(date => this.guidedDay(board, date, caps.get(date)!, events, sortTasks(all.filter(t => t.planned === date)), date === td, addBox));
    } else {
      this.renderCheck(main, days, caps, all, noDay.filter(t => t.status !== "done"), plannedTotal, freeTotal);
    }
    keep.forEach((v, k) => { const e = this.root.querySelector<HTMLElement>(`[data-scroll="${k}"]`); if (e) { e.scrollTop = v; if (k === "kb") e.scrollLeft = this.kbX; } });
  }

  /** Tickets step: a card of the board with the tasks that already exist for the ticket and the "New task" button. */
  private ticketCard(cell: HTMLElement, tk: Ticket, tasks: Task[], wk: string) {
    const s = this.plugin.settings; const title = tk.summary || tk.key;
    const card = cell.createDiv("samaya-kb-card");
    const top = card.createDiv("samaya-kb-cardtop");
    top.createSpan({ cls: `samaya-chip samaya-chip-ticket is-${tk.source}`, text: tk.key });
    if (tasks.length) top.createSpan({ cls: "samaya-chip samaya-chip-channel", text: tasks.length === 1 ? "1 task" : `${tasks.length} tasks`, attr: { title: tasks.map(t => t.title).join("\n") } });
    card.createDiv({ cls: "samaya-kb-title", text: title });
    const meta = [tk.issueType, tk.assignee].filter(Boolean).join(" · "); if (meta) card.createDiv({ cls: "samaya-kb-meta", text: meta });
    card.createEl("button", { cls: "samaya-mini samaya-kb-new", text: "New task" }).addEventListener("click", e => {
      e.stopPropagation();
      new TicketTaskModal(this.plugin, tk.key, title, r => {
        const when: Record<string, string | number> = r.when === "week" ? { week: wk } : r.when === "today" ? { planned: today() } : { horizon: r.when, ...(horizonTarget(r.when, today()) ? { later: horizonTarget(r.when, today()) } : {}) };
        createTask(this.app, s, r.name || title, { ...when, estimate: r.estimate ?? s.defaultEstimate, ticket: `[[${tk.file.basename}]]` })
          .then(() => { window.setTimeout(() => this.schedule(), 250); })
          .catch((err: unknown) => { new Notice(`Samaya: could not create the task (${err instanceof Error ? err.message : String(err)})`); });
      }).open();
    });
    card.addEventListener("click", e => { if (e.target instanceof HTMLElement && e.target.closest("button")) return; void this.app.workspace.getLeaf(e.ctrlKey || e.metaKey ? "tab" : false).openFile(tk.file); });
  }

  /** One day of the Schedule step: its meetings as a compact agenda on top, then the load bar and the day's tasks. */
  private guidedDay(parent: HTMLElement, date: string, cap: Capacity, events: IcsEvent[], tasks: Task[], isToday: boolean, addBox: (col: HTMLElement, placeholder: string, props: () => Record<string, string | number>) => void) {
    const s = this.plugin.settings; const dayMs = parseYmd(date).getTime();
    const col = parent.createDiv({ cls: "samaya-col samaya-wg-day" + (isToday ? " is-today" : "") });
    const share = bufferShare(s.bufferPercent); const planned = tasks.reduce((a, t) => a + (t.estimate || 0), 0); const lvl = loadLevel(planned, cap.free, share);
    const h = col.createDiv("samaya-col-head");
    const left = h.createDiv("samaya-col-headl");
    left.createSpan({ cls: "samaya-col-title samaya-colhead-title", text: parseYmd(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) });
    left.createSpan({ cls: "samaya-colhead-count", text: String(tasks.length) });
    const sum = h.createSpan({ cls: `samaya-col-cap is-${lvl}`, text: `${fmtDur(planned)}/${fmtDur(cap.free)}` });
    sum.title = `Free to plan = ${fmtDur(cap.total)} work time - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings. Keep about ${Math.round((1 - share) * 100)}% of it free.`;
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
    addBox(col, "+ Add task", () => ({ planned: date, order: tasks.length }));
    const body = col.createDiv("samaya-col-body");
    tasks.forEach((t, idx) => {
      const c = renderTaskCard(this.plugin, body, t, { scope: this.scope, showTime: true });
      bindCardDrop(this.scope, c, (path, after) => { void placeInDay(this.app, s, path, date, idx + (after ? 1 : 0)); });
    });
    bindZone(this.scope, col, path => { void placeInDay(this.app, s, path, date, tasks.length); });
  }

  /** Check step: a verdict on the week, the week's numbers, a column per day (meetings, planned work, the 80% buffer line) and what is left to fix. */
  private renderCheck(main: HTMLElement, days: string[], caps: Map<string, Capacity>, tasks: Task[], noDay: Task[], plannedTotal: number, freeTotal: number) {
    const s = this.plugin.settings; const td = today(); const g = this.plugin.guide; const share = bufferShare(s.bufferPercent);
    const rows = days.map(date => {
      const cap = caps.get(date)!; const ts = tasks.filter(t => t.planned === date);
      const planned = ts.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0);
      return { date, cap, planned, count: ts.length, done: ts.filter(t => t.status === "done").length, level: loadLevel(planned, cap.free, share) };
    });
    const v = weekVerdict(rows.map(r => ({ planned: r.planned, free: r.cap.free })), share);
    const name = (d: string, long = true) => parseYmd(d).toLocaleDateString(undefined, { weekday: long ? "long" : "short" });
    const back = () => { if (g) { g.step = 3; this.plugin.bus.emit(); } };

    const box = main.createDiv("samaya-chk");
    // ---- verdict
    const copy = {
      ok: ["A realistic week", "Every day keeps room for the unexpected.", "check-circle-2"],
      tight: ["A full week", `${v.tight} ${v.tight === 1 ? "day is" : "days are"} past the ${Math.round(share * 100)}% buffer. Something will probably slip.`, "alert-triangle"],
      over: ["An overloaded week", `${v.over} ${v.over === 1 ? "day plans" : "days plan"} more than there is time for.`, "alert-octagon"],
    }[v.level];
    const hero = box.createDiv(`samaya-chk-hero is-${v.level}`);
    setIcon(hero.createDiv("samaya-chk-hero-icon"), copy[2]);
    const ht = hero.createDiv("samaya-chk-hero-text");
    ht.createDiv({ cls: "samaya-chk-hero-title", text: copy[0] }); ht.createDiv({ cls: "samaya-chk-hero-sub", text: copy[1] });
    const nPlaced = rows.reduce((a, r) => a + r.count, 0); const nAll = nPlaced + noDay.length;
    ht.createDiv({ cls: "samaya-chk-hero-count", text: `${nAll} ${nAll === 1 ? "task" : "tasks"} · ${nPlaced} scheduled${noDay.length ? ` · ${noDay.length} without a day` : ""}` });

    // ---- the week in numbers
    const meetings = rows.reduce((a, r) => a + r.cap.meetings, 0);
    const stats = box.createDiv("samaya-chk-stats");
    const stat = (label: string, value: string, sub = "", cls = "") => { const t = stats.createDiv("samaya-chk-stat " + cls); t.createDiv({ cls: "samaya-chk-stat-label", text: label }); t.createDiv({ cls: "samaya-chk-stat-value", text: value }); if (sub) t.createDiv({ cls: "samaya-chk-stat-sub", text: sub }); };
    const spare = rows.reduce((a, r) => a + Math.max(0, r.cap.free - r.planned), 0); // time with neither a meeting nor a task (a day that is over does not eat into another one)
    stat("Tasks", fmtDur(plannedTotal), `${nPlaced} planned · ${fmtDur(Math.round(freeTotal * share))} recommended`, `is-tasks is-${loadLevel(plannedTotal, freeTotal, share)}`);
    stat("Meetings", fmtDur(meetings), `${rows.filter(r => r.cap.meetings).length} of ${rows.length} days`, "is-meet");
    stat("Unplanned time", fmtDur(spare), "no meetings or tasks", "is-open");

    // ---- day by day
    box.createDiv({ cls: "samaya-chk-h", text: "Day by day" });
    const grid = box.createDiv("samaya-chk-days"); grid.style.setProperty("--n", String(rows.length));
    for (const r of rows) {
      const card = grid.createDiv(`samaya-chk-day is-${r.level}` + (r.date === td ? " is-today" : ""));
      const top = card.createDiv("samaya-chk-day-top");
      top.createSpan({ cls: "samaya-chk-day-name", text: name(r.date, false) });
      top.createSpan({ cls: "samaya-chk-day-date", text: parseYmd(r.date).toLocaleDateString(undefined, { day: "numeric", month: "short" }) });
      const avail = r.cap.free + r.cap.meetings; // time in the workday that is not lunch
      const bar = card.createDiv("samaya-chk-bar");
      if (avail > 0) {
        const pct = (m: number) => `${Math.min(100, Math.max(0, (m / avail) * 100))}%`;
        bar.createDiv("samaya-chk-seg is-meet").style.height = pct(r.cap.meetings);
        const work = bar.createDiv(`samaya-chk-seg is-work is-${r.level}`); work.style.bottom = pct(r.cap.meetings); work.style.height = pct(Math.min(r.planned, r.cap.free + (r.planned > r.cap.free ? r.cap.meetings : 0)));
        const line = bar.createDiv("samaya-chk-line"); line.style.bottom = pct(r.cap.meetings + r.cap.free * share); line.title = `${Math.round(share * 100)}% of the free time`;
      } else bar.addClass("is-off");
      const kv = card.createDiv("samaya-chk-kvs");
      const row = (cls: string, label: string, value: string, extra = "") => { const k = kv.createDiv("samaya-chk-kv"); k.createSpan({ cls: `samaya-chk-swatch ${cls}` }); k.createSpan({ cls: "samaya-chk-kv-label", text: label }); k.createSpan({ cls: "samaya-chk-kv-value", text: value }); if (extra) k.createSpan({ cls: "samaya-chk-kv-extra", text: extra }); };
      row("is-work", `Tasks (${r.count})`, fmtDur(r.planned));
      row("is-meet", "Meetings", fmtDur(r.cap.meetings));
      row("is-open", "Unplanned", fmtDur(Math.max(0, r.cap.free - r.planned)));
      const trim = trimToBuffer(r.planned, r.cap.free, share);
      card.createDiv({ cls: "samaya-chk-day-flag", text: r.level === "over" ? `Over by ${fmtDur(r.planned - r.cap.free)}` : r.level === "tight" ? `${fmtDur(trim)} past the buffer` : r.count ? `${fmtDur(Math.max(0, Math.round(r.cap.free * share) - r.planned))} to spare` : "Nothing planned" });
    }
    const legend = box.createDiv("samaya-chk-legend");
    for (const [cls, text] of [["is-meet", "Meetings"], ["is-work", "Tasks"], ["is-open", "Unplanned"], ["is-line", `${Math.round(share * 100)}% line`]]) { const l = legend.createSpan("samaya-chk-legend-item"); l.createSpan({ cls: `samaya-chk-swatch ${cls}` }); l.createSpan({ text }); }

    // ---- what is left to fix
    const todo: Array<[string, string]> = [];
    const heavy = rows.filter(r => r.level !== "ok");
    if (heavy.length) todo.push(["Lighten " + heavy.map(r => name(r.date)).join(", "), `Move about ${fmtDur(Math.max(...heavy.map(r => trimToBuffer(r.planned, r.cap.free, share))))} off the fullest day to a lighter one, or back to the backlog.`]);
    if (noDay.length) todo.push([`${noDay.length} ${noDay.length === 1 ? "task has" : "tasks have"} no day`, `${noDay.slice(0, 3).map(t => t.title).join(", ")}${noDay.length > 3 ? ` and ${noDay.length - 3} more` : ""}. Give ${noDay.length === 1 ? "it" : "them"} a day, or keep ${noDay.length === 1 ? "it" : "them"} as a pool to draw from.`]);
    const fix = box.createDiv("samaya-chk-fix" + (todo.length ? "" : " is-clear"));
    if (!todo.length) { setIcon(fix.createDiv("samaya-chk-fix-icon"), "check"); fix.createDiv({ cls: "samaya-chk-fix-title", text: "Nothing left to fix. Press Finish week plan when you are ready." }); }
    else {
      fix.createDiv({ cls: "samaya-chk-fix-head", text: "Before you finish" });
      for (const [title, text] of todo) { const it = fix.createDiv("samaya-chk-fix-item"); const t = it.createDiv("samaya-chk-fix-text"); t.createDiv({ cls: "samaya-chk-fix-title", text: title }); t.createDiv({ cls: "samaya-chk-fix-sub", text }); }
      fix.createEl("button", { cls: "samaya-chk-fix-btn", text: "Back to Schedule" }).onclick = back;
    }
  }
}
