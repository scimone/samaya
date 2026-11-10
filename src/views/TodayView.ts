import { ItemView, Menu, TFile, setIcon, WorkspaceLeaf, normalizePath } from "obsidian";
import type SamayaPlugin from "../main";
import type { IcsEvent } from "../ics";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { DndScope } from "../dnd";
import { ensureMeetingNote } from "../meetings";
import { Task, prefixOf, allTasks, createTask, patchTask, readTask, setDone, sortTasks } from "../model";
import { layoutItems } from "../timeline";
import { addDays, fmtDur, hmToMin, minToHm, parseTitleEstimate, parseYmd, startOfWeek, today } from "../util";
import { bindZone, renderBacklogBuckets, renderTaskCard, richText, showTaskMenu } from "./common";
import { renderLoadBar } from "./loadBar";
import { renderDayLines } from "./dayLines";
import { decorateSegment, dragDur, dropOnTimeline, resizeBlock, segLabel, taskBlocks } from "./place";
import { addBands } from "./bands";
import { renderWorkdayCard } from "./workdayCard";
import { renderDoneBar } from "./doneBar";
import { renderWeekColumn, weekFreeTime } from "./weekColumn";

export const TODAY_VIEW_TYPE = "samaya-today";
const MIN_HOUR_H = 28;

/** Right-sidebar timeline of today: unscheduled cards on top, draggable timeline below. */
export class TodayView extends ItemView {
  private timer = 0;
  private scrolled = "";
  private scrollTop = 0;
  private token = 0;
  private pending = false;
  private dnd = new DndScope();
  private mode: "timeline" | "daily" | "week" = "timeline";
  private tab: "week" | "backlog" = "week";
  private shownDate = "";
  private shownWeek = "";
  private viewDate = ""; // day shown on the timeline ("" = today)
  private listTop = 0;
  private wgScroll = 0;
  private seenH = 0;
  constructor(leaf: WorkspaceLeaf, private plugin: SamayaPlugin) { super(leaf); this.dnd.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } }; }
  getViewType() { return TODAY_VIEW_TYPE; }
  getDisplayText() { return "Today"; }
  getIcon() { return "calendar-clock"; }

  async onOpen() {
    this.contentEl.addClass("samaya-today");
    const under = (f: { path: string }) => f.path.startsWith(prefixOf(this.plugin.settings.tasksPath)) || inEventFolder(this.plugin.settings, f.path);
    this.registerEvent(this.app.metadataCache.on("changed", f => { if (under(f)) this.schedule(); }));
    this.registerEvent(this.app.vault.on("delete", f => { if (under(f)) this.schedule(); }));
    this.registerEvent(this.app.vault.on("rename", f => { if (under(f)) this.schedule(); }));
    this.registerInterval(window.setInterval(() => { if (!this.dnd.active) void this.render(); }, 60000));
    this.register(this.plugin.bus.on(() => this.schedule()));
    // while the Daily view is the page in front, the timeline follows the day it shows
    const check = () => { if (this.currentMode() !== this.mode || (this.mode === "daily" && this.plugin.plannerDate !== this.shownDate) || (this.mode === "week" && this.plugin.boardWeek !== this.shownWeek)) this.schedule(); };
    this.registerEvent(this.app.workspace.on("active-leaf-change", check));
    this.registerEvent(this.app.workspace.on("layout-change", check));
    this.register(this.plugin.modeBus.on(check));
    const ro = new ResizeObserver(() => { if (this.contentEl.clientHeight !== this.seenH && this.mode !== "week") this.schedule(); });
    ro.observe(this.contentEl); this.register(() => ro.disconnect());
    await this.render();
  }
  onClose() { window.clearTimeout(this.timer); this.dnd.dispose(); return Promise.resolve(); }
  private schedule() {
    if (this.dnd.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render(); }, 120);
  }

  private currentMode(): "timeline" | "daily" | "week" {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const el = (leaf?.view as { containerEl?: HTMLElement } | undefined)?.containerEl;
    if (this.plugin.guide?.kind === "week" && Array.from(el?.querySelectorAll(".samaya-week") ?? []).some(w => !w.closest(".is-hidden"))) return "week"; // only Plan week still uses the sidebar for the This week column
    return this.plannerOpen() ? "daily" : "timeline";
  }

  private plannerOpen(): boolean {
    const leaf = this.app.workspace.getMostRecentLeaf(); // most recent leaf of the MAIN area, even while a sidebar is focused
    const el = (leaf?.view as { containerEl?: HTMLElement } | undefined)?.containerEl;
    return Array.from(el?.querySelectorAll(".samaya-daily") ?? []).some(w => !w.closest(".is-hidden"));
  }

  async render() {
    const token = ++this.token; const s = this.plugin.settings;
    this.mode = this.currentMode(); const daily = this.mode === "daily"; const guide = daily && this.plugin.guide?.kind !== "week" ? this.plugin.guide : null;
    const ro = !!guide && guide.kind === "plan" && guide.step <= 1; // plan my day: read-only until Timebox
    const date = daily ? this.plugin.plannerDate || today() : this.viewDate || today();
    this.shownDate = this.plugin.plannerDate;
    const wkStart = this.plugin.boardWeek || startOfWeek(today()); this.shownWeek = this.plugin.boardWeek;
    const wg = this.mode === "week" && this.plugin.guide?.kind === "week" ? this.plugin.guide : null; // Plan my week: this sidebar holds the This week column
    const free = wg ? await weekFreeTime(this.plugin, wkStart, wg.days ?? 5) : 0;
    const events: IcsEvent[] = calendarEnabled(s) ? await calendarEvents(this.plugin, parseYmd(date), new Date(parseYmd(date).getTime() + 86400000)) : [];
    const notes = new Map<IcsEvent, TFile>();
    for (const ev of events.filter(e => !e.allDay)) { try { notes.set(ev, await ensureMeetingNote(this.app, s, ev, events)); } catch { /* ignore */ } }
    if (token !== this.token) return;
    if (this.dnd.active) { this.pending = true; return; }

    const c = this.contentEl; const old = c.querySelector<HTMLElement>(".samaya-scroll"); if (old) this.scrollTop = old.scrollTop;
    const oldU = c.querySelector<HTMLElement>(".samaya-today-cards"); const uTop = oldU?.scrollTop ?? 0;
    c.empty(); this.dnd.clear();
    const all = allTasks(this.app, s);
    const day = sortTasks(all.filter(t => t.planned === date));
    const byPath = new Map(day.map(t => [t.file.path, t]));
    if (wg) {
      c.addClass("is-wg");
      renderWeekColumn(this.plugin, this.dnd, c, { step: wg.step, wk: wkStart, all, free, refresh: () => this.schedule(), keepScroll: this.wgScroll, onScroll: y => { this.wgScroll = y; } });
      return;
    }
    c.removeClass("is-wg");

    // ---- header: title, workday strip, capacity - kept minimal
    const head = c.createDiv("samaya-today-head");
    const d = parseYmd(date); const isToday = date === today();
    const title = head.createDiv("samaya-today-title");
    if (!daily && this.mode !== "week") {
      const nav = (icon: string, label: string, to: () => string) => {
        const b = title.createEl("button", { cls: "samaya-day-nav clickable-icon", attr: { "aria-label": label } }); setIcon(b, icon);
        b.addEventListener("click", () => { const n = to(); this.viewDate = n === today() ? "" : n; void this.render(); });
      };
      nav("chevron-left", "Previous day", () => addDays(date, -1));
      title.createSpan({ cls: "samaya-today-dow", text: d.toLocaleDateString(undefined, { weekday: "long" }) });
      title.createSpan({ cls: "samaya-today-date", text: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) });
      nav("chevron-right", "Next day", () => addDays(date, 1));
      if (!isToday) { const t = title.createEl("button", { cls: "samaya-mini", text: "Today" }); t.addEventListener("click", () => { this.viewDate = ""; void this.render(); }); }
    }
    const dayMs = parseYmd(date).getTime();
    if (daily) {
      head.remove(); // the Daily view shows the day title, workday strip and progress itself
      if (!guide) { // one clear way into the week: the timeline expands to the whole week
        const bar = c.createDiv("samaya-tl-bar");
        bar.createSpan({ cls: "samaya-tl-bar-title", text: "Timeline" });
        const sw = bar.createDiv("samaya-modeswitch");
        sw.createEl("button", { text: "Day", cls: "is-active" });
        sw.createEl("button", { text: "Week", attr: { title: "Expand to the week timeline" } }).onclick = () => this.plugin.expandTimeline();
      }
    }
    else {
      renderWorkdayCard(this.plugin, head.createDiv(), { compact: true });
      renderDoneBar(head, day.filter(t => t.status === "done").length, day.length);
    }
    events.filter(e => e.allDay).forEach(e => c.createDiv({ cls: "samaya-allday", text: e.title }));

    if (!daily) { // (not next to the Daily view: its planned list is the source)
    // ---- unscheduled cards (drop here to unschedule)
    const unscheduled = day.filter(t => !t.start && t.status !== "done");
    const usec = c.createDiv("samaya-today-unsched");
    usec.createDiv({ cls: "samaya-today-label", text: `Unscheduled · ${unscheduled.length}` });
    const cards = usec.createDiv("samaya-today-cards");
    if (!unscheduled.length) cards.createDiv({ cls: "samaya-today-empty", text: "Everything has a time slot" });
    unscheduled.forEach(t => renderTaskCard(this.plugin, cards, t, { scope: this.dnd, compact: true }));
    cards.scrollTop = uTop;
    bindZone(this.dnd, usec, path => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) void patchTask(this.app, f, { planned: date, week: null, start: null });
    });

    }

    // ---- timeline
    const startH = s.dayStartHour, endH = s.dayEndHour, slot = s.slotMinutes; const dayStartMs = dayMs;
    c.createDiv({ cls: "samaya-today-label", text: "Timeline" });
    const scroll = c.createDiv("samaya-scroll");
    // stretch the hours so the day fills the whole sidebar height
    this.seenH = c.clientHeight;
    const HOUR_H = Math.max(MIN_HOUR_H, Math.floor((scroll.clientHeight - 12) / (endH - startH)));
    const grid = scroll.createDiv("samaya-grid"); grid.style.height = `${(endH - startH) * HOUR_H}px`;
    for (let h = startH; h < endH; h++) {
      const row = grid.createDiv("samaya-hour"); row.style.top = `${(h - startH) * HOUR_H}px`; row.style.height = `${HOUR_H}px`;
      row.createSpan({ cls: "samaya-hour-label", text: minToHm(h * 60) });
      row.createDiv("samaya-hour-half");
    }
    const lane = grid.createDiv("samaya-lane");
    addBands(this.plugin, lane, date, startH, endH, HOUR_H, date);
    const px = (m: number) => ((m - startH * 60) / 60) * HOUR_H;
    const snap = (y: number) => Math.round((y / HOUR_H * 60 + startH * 60) / slot) * slot;
    const startFor = (i: { y: number; grabY: number }, dur: number) => {
      const m = snap(i.y - lane.getBoundingClientRect().top - i.grabY);
      return Math.max(startH * 60, Math.min(endH * 60 - Math.min(dur, slot), m));
    };
    const durOf = (path: string, seg: number | null) => dragDur(byPath.get(path), seg, s.defaultEstimate);

    let preview: HTMLElement | null = null;
    if (!ro) { // drop target: give a task a time slot
    // target = the visible scroll box (the lane itself extends beyond it when scrolled)
    this.dnd.target(scroll, {
      over: i => {
        const dur = durOf(i.path, i.seg); const m = startFor(i, dur);
        if (!preview) preview = lane.createDiv("samaya-preview");
        preview.style.top = `${px(m)}px`; preview.style.height = `${Math.max(20, (dur / 60) * HOUR_H - 2)}px`;
        preview.setText(`${minToHm(m)} – ${minToHm(m + dur)}`);
      },
      leave: () => { preview?.remove(); preview = null; },
      drop: i => {
        preview?.remove(); preview = null;
        const f = this.app.vault.getAbstractFileByPath(i.path); if (!(f instanceof TFile)) return;
        const dur = dragDur(readTask(this.app, f), i.seg, s.defaultEstimate);
        void dropOnTimeline(this.plugin, f, date, startFor(i, dur), i.seg, events, endH * 60, slot);
      },
    });

    }

    interface Item { s: number; dur: number; task?: Task; ev?: IcsEvent; seg?: number; n?: number; }
    const items: Item[] = [];
    events.filter(e => !e.allDay).forEach(e => {
      const sm = Math.max(0, (e.start.getTime() - dayStartMs) / 60000), em = Math.min(1440, (e.end.getTime() - dayStartMs) / 60000);
      if (em > startH * 60 && sm < endH * 60) items.push({ s: sm, dur: Math.max(15, em - sm), ev: e });
    });
    day.filter(t => t.start).forEach(t => { const bl = taskBlocks(t, s.defaultEstimate); bl.forEach((g, k) => items.push({ s: g.s, dur: g.dur, task: t, seg: k, n: bl.length })); });
    items.sort((a, b) => a.s - b.s || b.dur - a.dur);
    const slots = layoutItems(items);
    const open = (f: TFile) => { void this.app.workspace.getLeaf("tab").openFile(f); };
    const nowD = new Date(); const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
    items.forEach(it => {
      if (it.s + it.dur <= startH * 60 || it.s >= endH * 60) return;
      const pl = slots.get(it)!; const top = px(Math.max(it.s, startH * 60));
      const height = Math.max(22, px(Math.min(it.s + it.dur, endH * 60)) - top - 2);
      const b = lane.createDiv({ cls: it.ev ? "samaya-event" : "samaya-block" + (it.task!.status === "done" ? " is-done" : "") });
      b.style.top = `${top}px`; b.style.height = `${height}px`; b.style.left = `${(pl.col * 100) / pl.n}%`; b.style.width = `calc(${100 / pl.n}% - 3px)`;
      if (isToday && nowMin >= it.s && nowMin < it.s + it.dur && it.task?.status !== "done") b.addClass("is-current");
      if (it.ev && (date < today() || (isToday && nowMin >= it.s + it.dur))) b.addClass("is-past"); // a meeting that is over
      const bt = b.createDiv({ cls: it.ev ? "samaya-event-title" : "samaya-block-title" });
      if (!it.ev) {
        const task = it.task!;
        const st = bt.createSpan({ cls: "samaya-block-state", attr: { title: task.status === "done" ? "Mark as not done" : "Mark as done" } });
        st.addEventListener("click", e => { e.stopPropagation(); void setDone(this.app, task, task.status !== "done"); });
      }
      bt.createSpan({ text: it.ev ? it.ev.title : it.task!.title });
      b.createDiv({ cls: it.ev ? "samaya-event-time" : "samaya-block-time", text: `${minToHm(it.s)} – ${minToHm(it.s + it.dur)}${it.ev ? "" : segLabel(it.seg!, it.n!)}` });
      if (it.ev) { const n = notes.get(it.ev); if (n) { b.title = "Open meeting note"; b.addEventListener("click", () => open(n)); } return; }
      const t = it.task!;
      decorateSegment(b, t, it.seg!, it.n!, lane);
      b.addEventListener("dblclick", () => open(t.file));
      b.addEventListener("contextmenu", e => showTaskMenu(this.plugin, t, e));
      if (ro) return; // read-only while reviewing and picking
      this.dnd.draggable(b, t.file.path);
      const handle = b.createDiv("samaya-resize");
      handle.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        const startY = e.clientY; const dur0 = it.dur; let nd = dur0;
        const move = (ev: PointerEvent) => {
          nd = Math.max(slot, Math.round((dur0 + ((ev.clientY - startY) / HOUR_H) * 60) / slot) * slot);
          b.style.height = `${Math.max(22, (nd / 60) * HOUR_H - 2)}px`;
        };
        const up = () => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
          if (nd !== dur0) void resizeBlock(this.plugin, t, it.seg!, nd);
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      });
    });

    renderDayLines(this.plugin, date, lane, grid, { startH, endH, slot }, HOUR_H, px);
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    if (isToday && nm >= startH * 60 && nm <= endH * 60) lane.createDiv("samaya-now").style.top = `${px(nm)}px`;
    if (this.scrolled !== date) { this.scrolled = date; this.scrollTop = Math.max(0, px(nm) - 120); }
    scroll.scrollTop = this.scrollTop;
  }
}
