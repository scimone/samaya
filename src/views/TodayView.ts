import { ItemView, Menu, TFile, setIcon, WorkspaceLeaf, normalizePath } from "obsidian";
import type SamayaPlugin from "../main";
import type { IcsEvent } from "../ics";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { DndScope } from "../dnd";
import { ensureMeetingNote } from "../meetings";
import { Task, prefixOf, allTasks, createTask, patchTask, readTask, setDone, sortTasks } from "../model";
import { renderTimeline, TimelineState } from "./timelineKit";
import { renderDayStatus } from "./dayStatus";
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
  private tlState: TimelineState = { scrolled: "", scrollTop: 0 };
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
    const ro = new ResizeObserver(() => { if (this.contentEl.clientHeight !== this.seenH && this.mode === "timeline") this.schedule(); });
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
    this.mode = this.currentMode(); const daily = this.mode === "daily";
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
    if (wg) {
      c.addClass("is-wg");
      renderWeekColumn(this.plugin, this.dnd, c, { step: wg.step, wk: wkStart, all, free, refresh: () => this.schedule(), keepScroll: this.wgScroll, onScroll: y => { this.wgScroll = y; } });
      return;
    }
    c.removeClass("is-wg");
    // the status column: next to the planner it steps the planner's day, elsewhere it shows (and steps) the day on its own
    const info = c.createDiv("samaya-info is-side");
    const go = (d: string) => { if (daily) this.plugin.plannerGoTo?.(d); else { this.viewDate = d === today() ? "" : d; void this.render(); } };
    await renderDayStatus(this.plugin, info, { date, events, go });
  }
}