import { BasesView, QueryController } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, createTask, placeInDay, readTask, sortTasks } from "../model";
import { addDays, fmtDur, hmToMin, parseTitleEstimate, parseYmd, startOfWeek, today } from "../util";
import { calendarEnabled, calendarEvents } from "../calendar";
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
    void this.plugin.openToday(); // the sidebar shows the week's unscheduled tasks while the board is open
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
    const all = this.data.data.map(e => readTask(this.app, e.file));
    const cols = this.root.querySelector<HTMLElement>(".samaya-cols");
    const scrollX = cols?.scrollLeft ?? 0; const scrollsY = Array.from(this.root.querySelectorAll<HTMLElement>(".samaya-col-body")).map(e => e.scrollTop);
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
    cols2.scrollLeft = scrollX;
    this.root.querySelectorAll<HTMLElement>(".samaya-col-body").forEach((e, i) => (e.scrollTop = scrollsY[i] ?? 0));
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
    const body = col.createDiv("samaya-col-body");
    tasks.forEach((t, idx) => {
      const c = renderTaskCard(this.plugin, body, t, { scope: this.scope, showTime: true });
      bindCardDrop(this.scope, c, (path, after) => { void placeInDay(this.app, this.plugin.settings, path, key, idx + (after ? 1 : 0)); });
    });
    bindZone(this.scope, col, path => { void placeInDay(this.app, this.plugin.settings, path, key, tasks.length); });
    const add = col.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: "+ Add task" } });
    add.addEventListener("keydown", e => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      const p = parseTitleEstimate(add.value); add.value = "";
      void createTask(this.app, this.plugin.settings, p.title, { planned: key, estimate: p.estimate ?? this.plugin.settings.defaultEstimate, order: tasks.length });
    });
  }
}
