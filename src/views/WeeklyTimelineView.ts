import { TFile, setIcon } from "obsidian";
import { PlannerPane } from "./plannerPane";
import type { PlannerHost } from "./plannerHost";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, allTasks, patchTask, readTask, setDone, sortTasks } from "../model";
import { addDays, fmtDur, hmToMin, minToHm, parseYmd, startOfWeek, today } from "../util";
import type { IcsEvent } from "../ics";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { layoutItems } from "../timeline";
import { bindZone, keyActivate, showTaskMenu } from "./common";
import { addBands } from "./bands";
import { renderWeekHead } from "./plannerHead";
import { decorateSegment, dragDur, dropOnTimeline, segLabel, taskBlocks } from "./place";

const MIN_HOUR_H = 40;

/** The calendar of one week: a column per day with meetings and the tasks that have a time slot. */
export class WeeklyTimelineView extends PlannerPane {
  private root: HTMLElement;
  private weekStart = startOfWeek(today());
  private scope = new DndScope();
  private pending = false;
  private timer = 0;
  private token = 0;
  private scrollTop = 0;
  private scrolledFor = "";
  private hourH = MIN_HOUR_H;
  private hours = 12;
  private fixed = 150; // height of everything but the hours (heading, day headers, padding), as last measured
  private seenH = 0;

  constructor(parentEl: HTMLElement, plugin: SamayaPlugin, private host?: PlannerHost) {
    super(plugin);
    this.root = parentEl.createDiv("samaya-wtl");
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
    const ro = new ResizeObserver(() => { if (!this.host?.flow?.() && this.root.clientHeight !== this.seenH) this.schedule(); });
    ro.observe(this.root); this.register(() => ro.disconnect());
    this.registerInterval(window.setInterval(() => this.updateNowLines(), 60000));
    this.register(plugin.bus.on(() => this.schedule()));
    const ref = plugin.app.metadataCache.on("changed", f => { if (inEventFolder(plugin.settings, f.path)) this.schedule(); });
    this.register(() => plugin.app.metadataCache.offref(ref));
  }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); if (this.plugin.boardWeek === this.weekStart) { this.plugin.boardWeek = ""; this.plugin.modeBus.emit(); } }
  onDataUpdated(): void { this.schedule(); }
  refresh() { this.schedule(); }
  getWeek() { return this.weekStart; }
  /** Planner: show the week that contains `date`. */
  showWeekOf(date: string) { this.weekStart = startOfWeek(date); this.scrolledFor = ""; this.schedule(); }
  private schedule() {
    if (this.host?.hidden()) return;
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render(); }, 30);
  }

  private opt(k: string, d: number) { const raw = this.config.get(k); return raw == null || raw === "" || isNaN(Number(raw)) ? d : Number(raw); }

  private async render() {
    const token = ++this.token; const s = this.plugin.settings;
    const startH = this.opt("dayStart", s.dayStartHour), endH = Math.max(startH + 1, this.opt("dayEnd", s.dayEndHour)), slot = s.slotMinutes;
    const days = this.config.get("showWeekends") === true ? 7 : 5;
    const events = this.config.get("showIcs") !== false && calendarEnabled(s)
      ? (await calendarEvents(this.plugin, parseYmd(this.weekStart), parseYmd(addDays(this.weekStart, 7))).catch(() => [] as IcsEvent[])) : [];
    if (token !== this.token) return;
    if (this.scope.active) { this.pending = true; return; }

    if (!this.host && this.plugin.guide?.kind === "week") { // the guide lives in the Weekly Board
      this.root.empty(); this.scope.clear();
      this.root.createDiv({ cls: "samaya-empty", text: "Planning your week happens in the Weekly Board view. Pick it from the view menu at the top of this tab." });
      return;
    }
    const flow = !!this.host?.flow?.(); this.root.toggleClass("is-flow", flow); // stacked above the board on one scrolling page
    const old = this.root.querySelector<HTMLElement>(".samaya-wtl-scroll"); if (old && !flow) this.scrollTop = old.scrollTop;
    this.root.empty(); this.scope.clear();
    const all = allTasks(this.app, this.plugin.settings);
    const byPath = new Map(all.map(t => [t.file.path, t]));

    if (this.plugin.boardWeek !== this.weekStart) { this.plugin.boardWeek = this.weekStart; this.plugin.modeBus.emit(); }
    const head = this.root.createDiv("samaya-week-head");
    renderWeekHead(head, this.weekStart, w => { if (this.host?.weekChanged) this.host.weekChanged(w); else { this.weekStart = w; this.scrolledFor = ""; void this.render(); } }, this.host?.back, this.host ? undefined : this.plugin);

    const scroll = this.root.createDiv("samaya-wtl-scroll");
    const cols = scroll.createDiv("samaya-wtl-heads");
    cols.createDiv("samaya-wtl-axis-spacer");
    // stretch the hours so the day fills the available height
    this.seenH = this.root.clientHeight;
    this.hours = endH - startH;
    const HOUR_H = this.hourH = flow ? this.fitFor(endH - startH, this.fixed) : Math.max(MIN_HOUR_H, Math.floor((scroll.clientHeight - 70) / (endH - startH)));
    const body = scroll.createDiv("samaya-wtl-body");
    this.root.style.setProperty("--wtl-hh", `${HOUR_H}px`); // every position below is a multiple of this, so the hours can stretch smoothly (fit)
    const L = (hours: number) => `calc(${hours} * var(--wtl-hh))`; const T = (m: number) => L((m - startH * 60) / 60);
    const axis = body.createDiv("samaya-wtl-axis"); axis.style.height = L(endH - startH);
    for (let h = startH; h < endH; h++) axis.createSpan({ cls: "samaya-wtl-hour-label", text: minToHm(h * 60) }).style.top = L(h - startH);
    const px = (m: number) => T(m);
    const open = (f: TFile) => { void this.app.workspace.getLeaf("tab").openFile(f); };

    for (let i = 0; i < days; i++) {
      const date = addDays(this.weekStart, i); const dayMs = parseYmd(date).getTime(); const isToday = date === today();
      const dayEvents = events.filter(e => e.end.getTime() > dayMs && e.start.getTime() < dayMs + 86400000);
      const dayTasks = sortTasks(all.filter(t => t.planned === date));

      // header: weekday, all-day events, tasks without a time slot
      const h = cols.createDiv("samaya-wtl-head" + (isToday ? " is-today" : ""));
      const dayLbl = h.createDiv({ cls: "samaya-wtl-day", text: parseYmd(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) });
      if (this.host?.openDay) { dayLbl.addClass("is-link"); dayLbl.title = "Open this day in the planner"; dayLbl.onclick = () => this.host?.openDay?.(date); keyActivate(dayLbl, `Open ${date} in the planner`, () => this.host?.openDay?.(date)); }
      dayEvents.filter(e => e.allDay).forEach(e => h.createDiv({ cls: "samaya-wtl-chip is-event", text: e.title }));
      dayTasks.filter(t => !t.start && t.status !== "done").forEach(t => {
        const c = h.createDiv({ cls: "samaya-wtl-chip", attr: { title: "No time slot yet - drag onto the calendar" } });
        c.createSpan({ cls: "samaya-wtl-chip-title", text: t.title });
        c.createSpan({ cls: "samaya-wtl-chip-est", text: fmtDur(t.estimate || s.defaultEstimate) });
        keyActivate(c, `Task without a time slot: ${t.title}. Press Enter to open`, () => open(t.file));
        c.addEventListener("dblclick", () => open(t.file)); c.addEventListener("contextmenu", e => showTaskMenu(this.plugin, t, e)); this.scope.draggable(c, t.file.path);
      });

      bindZone(this.scope, h, path => { // drop here = keep the day, remove the time slot
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) void patchTask(this.app, f, { planned: date, week: null, start: null });
      });
      const col = body.createDiv("samaya-wtl-col" + (isToday ? " is-today" : "")); col.style.height = L(endH - startH);
      for (let hr = startH; hr < endH; hr++) col.createDiv("samaya-wtl-hour").style.top = L(hr - startH);
      const lane = col.createDiv("samaya-lane");
      addBands(this.plugin, lane, date, startH, endH, () => this.hourH, today(), "var(--wtl-hh)");

      const startFor = (i2: { y: number; grabY: number }, dur: number) => {
        const m = Math.round((((i2.y - lane.getBoundingClientRect().top - i2.grabY) / this.hourH) * 60 + startH * 60) / slot) * slot;
        return Math.max(startH * 60, Math.min(endH * 60 - Math.min(dur, slot), m));
      };
      let preview: HTMLElement | null = null;
      this.scope.target(lane, {
        over: i2 => {
          const dur = dragDur(byPath.get(i2.path), i2.seg, s.defaultEstimate); const m = startFor(i2, dur);
          if (!preview) preview = lane.createDiv("samaya-preview");
          preview.style.top = px(m); preview.style.height = `max(18px, calc(${L(dur / 60)} - 2px))`;
          preview.setText(`${minToHm(m)} – ${minToHm(m + dur)}`);
        },
        leave: () => { preview?.remove(); preview = null; },
        drop: i2 => {
          preview?.remove(); preview = null;
          const f = this.app.vault.getAbstractFileByPath(i2.path); if (!(f instanceof TFile)) return;
          const dur = dragDur(readTask(this.app, f), i2.seg, s.defaultEstimate);
          void dropOnTimeline(this.plugin, f, date, startFor(i2, dur), i2.seg, dayEvents, endH * 60, slot);
        },
      });

      interface Item { s: number; dur: number; task?: Task; ev?: IcsEvent; seg?: number; n?: number; }
      const items: Item[] = [];
      dayEvents.filter(e => !e.allDay).forEach(e => {
        const sm = Math.max(0, (e.start.getTime() - dayMs) / 60000), em = Math.min(1440, (e.end.getTime() - dayMs) / 60000);
        if (em > startH * 60 && sm < endH * 60) items.push({ s: sm, dur: Math.max(15, em - sm), ev: e });
      });
      dayTasks.filter(t => t.start).forEach(t => { const bl = taskBlocks(t, s.defaultEstimate); bl.forEach((g, k) => items.push({ s: g.s, dur: g.dur, task: t, seg: k, n: bl.length })); });
      items.sort((a, b) => a.s - b.s || b.dur - a.dur);
      const slots = layoutItems(items);
      items.forEach(it => {
        if (it.s + it.dur <= startH * 60 || it.s >= endH * 60) return;
        const pl = slots.get(it)!; const top = px(Math.max(it.s, startH * 60));
        const height = `max(18px, calc(${L((Math.min(it.s + it.dur, endH * 60) - Math.max(it.s, startH * 60)) / 60)} - 2px))`;
        const b = lane.createDiv({ cls: it.ev ? "samaya-event" : "samaya-block" + (it.task!.status === "done" ? " is-done" : "") });
        b.style.top = top; b.style.height = height; b.style.left = `${(pl.col * 100) / pl.n}%`; b.style.width = `calc(${100 / pl.n}% - 2px)`;
        if (it.ev) {
          const nd = new Date(); if (date < today() || (isToday && nd.getHours() * 60 + nd.getMinutes() >= it.s + it.dur)) b.addClass("is-past"); // a meeting that is over
          b.createDiv({ cls: "samaya-event-title", text: it.ev.title });
          b.createDiv({ cls: "samaya-event-time", text: `${minToHm(it.s)}–${minToHm(it.s + it.dur)}` });
          return;
        }
        const t = it.task!;
        const bt = b.createDiv("samaya-block-title");
        const st = bt.createSpan({ cls: "samaya-block-state", attr: { title: t.status === "done" ? "Mark as not done" : "Mark as done" } });
        const toggle = () => { void setDone(this.app, t, t.status !== "done"); };
        st.addEventListener("click", e => { e.stopPropagation(); toggle(); });
        keyActivate(st, `Done: ${t.title}`, toggle, "checkbox"); st.setAttr("aria-checked", String(t.status === "done"));
        bt.createSpan({ text: t.title });
        b.createDiv({ cls: "samaya-block-time", text: `${minToHm(it.s)}–${minToHm(it.s + it.dur)} · ${fmtDur(it.dur)}${segLabel(it.seg!, it.n!)}` });
        decorateSegment(b, t, it.seg!, it.n!, lane);
        keyActivate(b, `Task: ${t.title}, ${minToHm(it.s)}–${minToHm(it.s + it.dur)}. Press Enter to open`, () => open(t.file));
        b.addEventListener("dblclick", () => open(t.file));
        b.addEventListener("contextmenu", e => showTaskMenu(this.plugin, t, e));
        this.scope.draggable(b, t.file.path);
      });
      if (isToday) { const nl = lane.createDiv("samaya-now"); nl.dataset.startH = String(startH); }
    }
    this.updateNowLines();
    if (this.scrolledFor !== this.weekStart) {
      this.scrolledFor = this.weekStart;
      const now = new Date(), nowM = now.getHours() * 60 + now.getMinutes();
      this.scrollTop = body.querySelector(".samaya-now") ? Math.max(0, ((nowM - startH * 60) / 60) * HOUR_H - 150) : Math.max(0, (8 - startH) * HOUR_H);
    }
    if (!flow) scroll.scrollTop = this.scrollTop;
    else if (this.host?.layout?.() === "timeline") this.fit(); // measured now: the hours fill the window exactly
  }

  /** Expanded week: hour height for the current layout. Timeline only: the hours fill the window. Otherwise: about two thirds of it, the board takes the rest. */
  private fitFor(hours: number, fixed: number) {
    const h = this.host?.viewH?.() ?? 700;
    const alone = this.host?.layout?.() === "timeline"; // alone it must fit the window without scrolling, however small
    return Math.max(alone ? 16 : MIN_HOUR_H, (alone ? h - (this.host?.barH?.() ?? 26) - fixed : h * 0.66 - 90) / hours);
  }
  /** The layout changed: stretch or shrink the hours to fit, as a CSS transition (no redraw). */
  fit() {
    const body = this.root.querySelector<HTMLElement>(".samaya-wtl-body"); if (!body || !this.host?.flow?.()) return;
    const fixed = this.root.offsetHeight - body.offsetHeight; // heading, day headers, padding
    this.fixed = fixed; const hh = this.fitFor(this.hours, fixed); if (hh === this.hourH) return; this.hourH = hh;
    this.root.addClass("is-fitting"); this.root.style.setProperty("--wtl-hh", `${this.hourH}px`);
    window.setTimeout(() => this.root.removeClass("is-fitting"), 520);
  }

  private updateNowLines() {
    const now = new Date();
    this.root.querySelectorAll<HTMLElement>(".samaya-now").forEach(nl => {
      nl.style.top = `calc(${(now.getHours() * 60 + now.getMinutes() - Number(nl.dataset.startH ?? 0) * 60) / 60} * var(--wtl-hh))`;
    });
  }
}
