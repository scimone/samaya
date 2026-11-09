import { BasesView, QueryController, TFile } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, createTask, patchTask, placeInDay, readTask, setDone, sortTasks } from "../model";
import { addDays, fmtDur, hmToMin, minToHm, parseTitleEstimate, parseYmd, startOfWeek, today } from "../util";
import { bindCardDrop, bindZone, renderTaskCard, showTaskMenu } from "./common";
import type { IcsEvent } from "../ics";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { ensureMeetingNote } from "../meetings";
import { layoutItems } from "../timeline";
import { addBands } from "./bands";
import { renderDoneBar } from "./doneBar";
import { renderGuide } from "./guide";
import { renderLoadBar } from "./loadBar";
import { renderDayLines } from "./dayLines";
import { renderWorkdayCard } from "./workdayCard";
import { capacityMinutes, Capacity } from "../worktime";

export const DAILY_VIEW_TYPE = "samaya-daily";
const HOUR_H = 60; // px per hour

export class DailyPlannerView extends BasesView {
  readonly type = DAILY_VIEW_TYPE;
  private root: HTMLElement;
  private date = today();
  private scope = new DndScope();
  private pending = false;
  private timer = 0;
  private token = 0;
  private leftScroll = 0;
  private gridScroll = 0;
  private scrolledFor = "";
  private announced = false;
  private meetingNotes = new Map<IcsEvent, TFile>();

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    this.root = parentEl.createDiv("samaya-daily");
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
    this.registerInterval(window.setInterval(() => this.updateNowLine(), 60000));
    this.register(plugin.bus.on(() => this.schedule()));
    const evRef = plugin.app.metadataCache.on("changed", f => { if (inEventFolder(plugin.settings, f.path)) this.schedule(); });
    this.register(() => plugin.app.metadataCache.offref(evRef));
  }

  private get opts() {
    const s = this.plugin.settings;
    const n = (k: string, d: number) => { const raw = this.config.get(k); return raw == null || raw === "" || isNaN(Number(raw)) ? d : Number(raw); };
    return { startH: n("dayStart", s.dayStartHour), endH: n("dayEnd", s.dayEndHour), slot: n("slot", s.slotMinutes), showIcs: this.config.get("showIcs") !== false };
  }
  private entryTasks(): Task[] { return this.data.data.map(e => readTask(this.app, e.file)); }

  onDataUpdated(): void { this.schedule(); }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); window.setTimeout(() => this.plugin.modeBus.emit(), 80); }

  /** Coalesce bursts of updates; never re-render in the middle of a drag. */
  private schedule() {
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.render(); }, 30);
  }

  private async render() {
    const token = ++this.token; const o = this.opts;
    const guide = this.plugin.guide;
    if (guide?.fresh) { guide.fresh = false; this.date = today(); this.scrolledFor = ""; }
    const events = o.showIcs && calendarEnabled(this.plugin.settings)
      ? await calendarEvents(this.plugin, parseYmd(this.date), parseYmd(addDays(this.date, 1))) : [];
    const meetingNotes = new Map<IcsEvent, TFile>();
    for (const ev of events.filter(e => !e.allDay)) { // sequential: same-titled meetings must not race
      try { meetingNotes.set(ev, await ensureMeetingNote(this.app, this.plugin.settings, ev, events)); } catch (e) { console.warn("Samaya: meeting note failed", e); }
    }
    this.meetingNotes = meetingNotes;
    if (token !== this.token || this.scope.active) { if (this.scope.active) this.pending = true; return; }

    const lp = this.root.querySelector<HTMLElement>(".samaya-left"); if (lp) this.leftScroll = lp.scrollTop;
    const gp = this.root.querySelector<HTMLElement>(".samaya-scroll"); if (gp) this.gridScroll = gp.scrollTop;
    this.root.empty(); this.scope.clear();

    const all = this.entryTasks(); const isToday = this.date === today();
    const day = sortTasks(all.filter(t => t.planned === this.date));
    const overdue = isToday ? sortTasks(all.filter(t => t.planned && t.planned < today() && t.status !== "done")) : [];

    // free capacity = capacity - lunch - calendar meetings
    const s = this.plugin.settings; const dayMs = parseYmd(this.date).getTime();
    const cap = capacityMinutes(s.capacityHours, this.plugin.lunchFor(this.date),
      events.filter(e => !e.allDay).map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]));
    const plannedAll = day.reduce((a, t) => a + (t.estimate || 0), 0);

    const g = isToday ? this.plugin.guide : null; const step = g?.step ?? -1;
    const review = step === 0; // Review: guide and left over tasks on top, the timeline lives in the sidebar
    this.root.toggleClass("is-review", review);
    const left = this.root.createDiv("samaya-left");
    this.renderHeader(left, day, cap, plannedAll, isToday, !!g);
    if (g) {
      if (review) {
        const band = left.createDiv("samaya-review-band");
        renderGuide(this.plugin, band, { overdue: overdue.length });
        this.renderLeftOver(band, overdue);
      } else renderGuide(this.plugin, left, { overdue: overdue.length });
      if (step >= 1) renderLoadBar(left, plannedAll, cap.free, `Free capacity = ${fmtDur(cap.total)} capacity - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`);
      left.createDiv({ cls: "samaya-today-label", text: `Planned for today · ${day.length}` });
    }

    if (overdue.length && !g) { // during the guide the left over tasks live in the sidebar
      const act = (t: Task): Array<[string, () => void]> => [
        ["Today", () => { void patchTask(this.app, t.file, { planned: today(), start: null }); }],
        ["Backlog", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: null }); }],
        ["Done", () => { void setDone(this.app, t, true); }],
      ];
      this.section(left, `Left over (${overdue.length})`, overdue, true, null, { actions: act });
    }

    const list = left.createDiv("samaya-list" + (step === 2 ? " is-timebox" : ""));
    if (!day.length) list.createDiv({ cls: "samaya-empty", text: "Nothing planned. Drag tasks here or add one below." });
    day.forEach((t, idx) => {
      const c = renderTaskCard(this.plugin, list, t, { scope: this.scope, showTime: true });
      c.toggleClass("is-timed", !!t.start);
      bindCardDrop(this.scope, c, (path, after) => { void placeInDay(this.app, this.plugin.settings, path, this.date, idx + (after ? 1 : 0)); });
    });
    bindZone(this.scope, list, path => { void placeInDay(this.app, this.plugin.settings, path, this.date, day.length); });

    const add = left.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: "+ Add task  (e.g. “Write report 1h”)" } });
    add.addEventListener("keydown", e => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      const p = parseTitleEstimate(add.value); add.value = "";
      void createTask(this.app, this.plugin.settings, p.title, { planned: this.date, estimate: p.estimate ?? this.plugin.settings.defaultEstimate, order: day.length });
    });

    left.scrollTop = this.leftScroll;

    if (!review) {
      const right = this.root.createDiv("samaya-right" + (step === 2 ? " is-guided" : ""));
      this.renderTimeline(right, day, events);
    }
    if (!this.announced || this.plugin.plannerDate !== this.date) { this.announced = true; this.plugin.plannerDate = this.date; this.plugin.modeBus.emit(); }
  }

  /** Review step: the left over tasks as a panel next to the guide. Decide with a button, or drag onto today's list or the sidebar timeline. */
  private renderLeftOver(host: HTMLElement, overdue: Task[]) {
    const col = host.createDiv("samaya-leftover is-guided");
    const head = col.createDiv("samaya-leftover-head");
    head.createSpan({ cls: "samaya-leftover-title", text: "Left over from earlier days" });
    head.createSpan({ cls: "samaya-leftover-count", text: String(overdue.length) });
    col.createDiv({ cls: "samaya-guide-text", text: "Pick a button, or drag a task onto today's list or the timeline in the sidebar." });
    const list = col.createDiv("samaya-leftover-list");
    if (!overdue.length) list.createDiv({ cls: "samaya-empty", text: "All cleared - nothing left over." });
    const tomorrow = addDays(today(), 1);
    overdue.forEach(t => renderTaskCard(this.plugin, list, t, {
      scope: this.scope,
      actions: [
        ["Today", () => { void patchTask(this.app, t.file, { planned: today(), start: null }); }],
        ["Tomorrow", () => { void patchTask(this.app, t.file, { planned: tomorrow, start: null }); }],
        ["Backlog", () => { void patchTask(this.app, t.file, { planned: null, start: null, week: null }); }],
        ["Done", () => { void setDone(this.app, t, true); }],
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
    const go = (x: string) => { this.date = x; this.scrolledFor = ""; void this.render(); };
    nav.createEl("button", { text: "‹", cls: "samaya-link-btn" }).onclick = () => go(addDays(this.date, -1));
    nav.createEl("button", { text: "Today", cls: "samaya-link-btn" }).onclick = () => go(today());
    nav.createEl("button", { text: "›", cls: "samaya-link-btn" }).onclick = () => go(addDays(this.date, 1));
    if (isToday) renderWorkdayCard(this.plugin, head.createDiv());
    const done = day.filter(t => t.status === "done").length;
    const tot = head.createDiv({ cls: "samaya-total" + (plannedAll > cap.free ? " is-over" : ""), text: `${fmtDur(plannedAll)} planned · ${fmtDur(cap.free)} free` });
    tot.title = `Free capacity = ${fmtDur(cap.total)} capacity - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`;
    renderDoneBar(head, done, day.length);
  }

  private section(left: HTMLElement, title: string, tasks: Task[], open: boolean, onDrop: ((path: string) => void) | null,
    o: { actions?: (t: Task) => Array<[string, () => void]>; guided?: boolean } = {}) {
    const d = left.createEl("details", { cls: "samaya-backlog" + (o.guided ? " is-guided" : "") }); d.open = open;
    d.createEl("summary", { text: title });
    const list = d.createDiv("samaya-list");
    tasks.forEach(t => renderTaskCard(this.plugin, list, t, { scope: this.scope, actions: o.actions?.(t) }));
    if (onDrop) bindZone(this.scope, d, onDrop);
  }

  private renderTimeline(right: HTMLElement, day: Task[], events: IcsEvent[]) {
    const o = this.opts; const byPath = new Map(this.entryTasks().map(t => [t.file.path, t]));
    const dayStartMs = parseYmd(this.date).getTime();
    events.filter(e => e.allDay).forEach(e => right.createDiv({ cls: "samaya-allday", text: e.title }));

    const scroll = right.createDiv("samaya-scroll");
    const grid = scroll.createDiv("samaya-grid"); grid.style.height = `${(o.endH - o.startH) * HOUR_H}px`;
    for (let h = o.startH; h < o.endH; h++) {
      const row = grid.createDiv("samaya-hour"); row.style.top = `${(h - o.startH) * HOUR_H}px`; row.style.height = `${HOUR_H}px`;
      row.createSpan({ cls: "samaya-hour-label", text: minToHm(h * 60) });
    }
    const lane = grid.createDiv("samaya-lane");
    addBands(this.plugin, lane, this.date, o.startH, o.endH, HOUR_H, today());
    const minToPx = (m: number) => ((m - o.startH * 60) / 60) * HOUR_H;
    const pxToMin = (px: number) => Math.round((px / HOUR_H * 60 + o.startH * 60) / o.slot) * o.slot;
    const clampStart = (m: number, dur: number) => Math.max(o.startH * 60, Math.min(o.endH * 60 - Math.min(dur, o.slot), m));

    // live preview while dragging over the grid
    let preview: HTMLElement | null = null;
    const startFor = (i: { y: number; grabY: number }, dur: number) => clampStart(pxToMin(i.y - lane.getBoundingClientRect().top - i.grabY), dur);
    this.scope.target(lane, {
      over: i => {
        const dur = byPath.get(i.path)?.estimate || this.plugin.settings.defaultEstimate; const m = startFor(i, dur);
        if (!preview) preview = lane.createDiv("samaya-preview");
        preview.style.top = `${minToPx(m)}px`; preview.style.height = `${Math.max(18, (dur / 60) * HOUR_H - 2)}px`;
        preview.setText(`${minToHm(m)} – ${minToHm(m + dur)}`);
      },
      leave: () => { preview?.remove(); preview = null; },
      drop: i => {
        preview?.remove(); preview = null;
        const f = this.app.vault.getAbstractFileByPath(i.path); if (!(f instanceof TFile)) return;
        const t = readTask(this.app, f); const dur = t.estimate || this.plugin.settings.defaultEstimate;
        void patchTask(this.app, f, { planned: this.date, week: null, start: minToHm(startFor(i, dur)), estimate: dur });
      },
    });

    // tasks and calendar events share one column; overlapping items sit side by side
    interface Item { s: number; dur: number; task?: Task; ev?: IcsEvent; }
    const items: Item[] = [];
    events.filter(e => !e.allDay).forEach(e => {
      const s = Math.max(0, (e.start.getTime() - dayStartMs) / 60000), en = Math.min(24 * 60, (e.end.getTime() - dayStartMs) / 60000);
      if (en > o.startH * 60 && s < o.endH * 60) items.push({ s, dur: Math.max(15, en - s), ev: e });
    });
    day.filter(t => t.start).forEach(t => items.push({ s: hmToMin(t.start), dur: t.estimate || this.plugin.settings.defaultEstimate, task: t }));
    items.sort((a, b) => a.s - b.s || b.dur - a.dur);
    const slotOf = layoutItems(items);
    items.forEach(it => {
      if (it.s + it.dur <= o.startH * 60 || it.s >= o.endH * 60) return;
      const pl = slotOf.get(it)!;
      const top = minToPx(Math.max(it.s, o.startH * 60)), height = Math.max(18, minToPx(Math.min(it.s + it.dur, o.endH * 60)) - top - 2);
      const place = (b: HTMLElement) => { b.style.top = `${top}px`; b.style.height = `${height}px`; b.style.left = `${(pl.col * 100) / pl.n}%`; b.style.width = `calc(${100 / pl.n}% - 2px)`; };
      if (it.ev) {
        const b = lane.createDiv({ cls: "samaya-event" }); place(b);
        const note = this.meetingNotes.get(it.ev);
        if (note) { b.title = "Open meeting note"; b.addEventListener("click", () => { void this.app.workspace.getLeaf("tab").openFile(note); }); }
        b.createDiv({ cls: "samaya-event-title", text: it.ev.title });
        b.createDiv({ cls: "samaya-event-time", text: `${minToHm(it.s)}–${minToHm(it.s + it.dur)}` });
        return;
      }
      const t = it.task!; const s = it.s, dur = it.dur;
      const b = lane.createDiv({ cls: "samaya-block" + (t.status === "done" ? " is-done" : "") }); place(b);
      const bt = b.createDiv({ cls: "samaya-block-title" });
      const st = bt.createSpan({ cls: "samaya-block-state", attr: { title: t.status === "done" ? "Mark as not done" : "Mark as done" } });
      st.addEventListener("click", e => { e.stopPropagation(); void setDone(this.app, t, t.status !== "done"); });
      bt.createSpan({ text: t.title });
      b.createDiv({ cls: "samaya-block-time", text: `${t.start}–${minToHm(s + dur)} · ${fmtDur(dur)}` });
      b.addEventListener("dblclick", () => { void this.app.workspace.getLeaf("tab").openFile(t.file); });
      b.addEventListener("contextmenu", e => showTaskMenu(this.plugin, t, e));
      this.scope.draggable(b, t.file.path);
      const handle = b.createDiv("samaya-resize");
      handle.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        const startY = e.clientY; let nd = dur;
        const move = (ev: PointerEvent) => {
          nd = Math.max(o.slot, Math.round((dur + ((ev.clientY - startY) / HOUR_H) * 60) / o.slot) * o.slot);
          b.style.height = `${Math.max(18, (nd / 60) * HOUR_H - 2)}px`;
        };
        const up = () => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
          if (nd !== dur) void patchTask(this.app, t.file, { estimate: nd });
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      });
    });

    renderDayLines(this.plugin, lane, grid, o, HOUR_H, minToPx);

    if (this.date === today()) {
      const nl = lane.createDiv("samaya-now"); nl.dataset.startH = String(o.startH); this.updateNowLine(nl);
    }
    // keep scroll position across re-renders; jump to "now" only when the day changes
    if (this.scrolledFor !== this.date) {
      this.scrolledFor = this.date;
      const nl = lane.querySelector<HTMLElement>(".samaya-now");
      this.gridScroll = nl ? Math.max(0, parseFloat(nl.style.top) - 150) : Math.max(0, (8 - o.startH) * HOUR_H);
    }
    scroll.scrollTop = this.gridScroll;
  }

  private updateNowLine(el?: HTMLElement) {
    const nl = el ?? this.root.querySelector<HTMLElement>(".samaya-now"); if (!nl) return;
    const now = new Date(); const startH = Number(nl.dataset.startH ?? 0);
    nl.style.top = `${((now.getHours() * 60 + now.getMinutes() - startH * 60) / 60) * HOUR_H}px`;
  }
}
