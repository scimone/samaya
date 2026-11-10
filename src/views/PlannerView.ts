import { BasesView, QueryController, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { today } from "../util";
import { DailyPlannerView, DAILY_VIEW_TYPE } from "./DailyPlannerView";
import { WeeklyBoardView } from "./WeeklyBoardView";
import { WeeklyTimelineView } from "./WeeklyTimelineView";
import type { PlannerHost } from "./plannerHost";

type Mode = "day" | "week" | "timeline" | "board";

export { DAILY_VIEW_TYPE as PLANNER_VIEW_TYPE }; // the id stays "samaya-daily" so existing planner bases keep working

/** The Planner: the day planner, which the week guide ("Plan week") takes over while it runs and gives back when it ends. */
export class PlannerView extends BasesView {
  readonly type = DAILY_VIEW_TYPE;
  private dayPane: HTMLElement;
  private weekPane: HTMLElement;
  private day: DailyPlannerView;
  private week: WeeklyBoardView;
  private tlPane: HTMLElement;
  private tl: WeeklyTimelineView;
  private shown: Mode;
  private tlHandle: HTMLElement;
  private boardHandle: HTMLElement;

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    const root = parentEl.createDiv("samaya-planner");
    this.dayPane = root.createDiv("samaya-planner-pane");
    this.weekPane = root.createDiv("samaya-planner-pane");
    this.tlPane = root.createDiv("samaya-planner-pane");
    this.boardHandle = this.makeHandle(this.weekPane, "top", "Timeline", "Show the week timeline", false);
    this.tlHandle = this.makeHandle(this.tlPane, "bottom", "Task board", "Show the task board", true);
    this.dayHost = { hidden: () => this.mode() !== "day" };
    this.weekHost = { hidden: () => this.mode() !== "week" && this.mode() !== "board", back: () => plugin.collapseTimeline() };
    this.day = new DailyPlannerView(controller, this.dayPane, plugin, this.dayHost);
    this.week = new WeeklyBoardView(controller, this.weekPane, plugin, this.weekHost);
    this.tl = new WeeklyTimelineView(controller, this.tlPane, plugin, { hidden: () => this.mode() !== "timeline", back: () => plugin.collapseTimeline(), openDay: d => { this.day.goTo(d); plugin.collapseTimeline(); } });
    for (const c of [this.day, this.week, this.tl]) { // the panes read the data and settings of this view
      Object.defineProperty(c, "data", { get: () => this.data, configurable: true });
      Object.defineProperty(c, "config", { get: () => this.config, configurable: true });
      Object.defineProperty(c, "allProperties", { get: () => this.allProperties, configurable: true });
      this.addChild(c);
    }
    this.shown = this.mode(); this.applyMode();
    this.register(plugin.bus.on(() => {
      const m = this.mode(); if (m === this.shown) return;
      const prev = this.shown; this.shown = m; this.applyMode(prev);
      const wk = prev === "timeline" ? this.tl.getWeek() : prev === "board" ? this.week.getWeek() : this.plugin.plannerDate || today(); // the week follows you between timeline and board
      if (m === "timeline") this.tl.showWeekOf(wk); else if (m === "board") this.week.showWeekOf(wk); else this.active().refresh();
    }));
    this.registerDomEvent(document, "keydown", e => { // Esc folds the expanded timeline back
      if (e.key !== "Escape" || (this.mode() !== "timeline" && this.mode() !== "board") || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null; if (t && (t.closest("input, textarea, [contenteditable=true]") || document.querySelector(".modal-container"))) return;
      plugin.collapseTimeline();
    });
  }
  onunload() { if (this.plugin.timelineWide) this.plugin.collapseTimeline(); } // closing the tab must not leave the sidebars folded
  private dayHost!: PlannerHost;
  private weekHost!: PlannerHost;

  private mode(): Mode { return this.plugin.guide?.kind === "week" ? "week" : this.plugin.timelineWide ? (this.plugin.weekBoard ? "board" : "timeline") : "day"; }
  private active() { const m = this.mode(); return m === "week" || m === "board" ? this.week : m === "timeline" ? this.tl : this.day; }
  /** A slim bar on the shared edge of the expanded week's two panes: click to slide to the other one. */
  private makeHandle(pane: HTMLElement, edge: "top" | "bottom", label: string, hint: string, toBoard: boolean) {
    const h = createDiv(`samaya-handle is-${edge}`);
    const b = h.createEl("button", { attr: { "aria-label": hint, title: hint } });
    setIcon(b.createSpan("samaya-handle-icon"), edge === "bottom" ? "chevrons-up" : "chevrons-down");
    b.createSpan({ cls: "samaya-handle-label", text: label });
    b.onclick = () => { this.plugin.weekBoard = toBoard; this.plugin.bus.emit(); this.plugin.modeBus.emit(); };
    if (edge === "top") pane.prepend(h); else pane.append(h);
    pane.addClass("is-stack");
    return h;
  }
  private applyMode(prev?: Mode) {
    this.dayPane.toggleClass("is-hidden", this.shown !== "day");
    this.weekPane.toggleClass("is-hidden", this.shown !== "week" && this.shown !== "board");
    this.tlPane.toggleClass("is-hidden", this.shown !== "timeline");
    this.boardHandle.toggleClass("is-hidden", this.shown !== "board");
    const pane = this.shown === "board" ? this.weekPane : this.shown === "timeline" ? this.tlPane : null;
    if (pane && (prev === "timeline" || prev === "board")) { // slide in from the side the handle sits on
      const cls = this.shown === "board" ? "is-enter-up" : "is-enter-down";
      pane.removeClass("is-enter-up", "is-enter-down"); void pane.offsetWidth; pane.addClass(cls);
      pane.addEventListener("animationend", () => pane.removeClass(cls), { once: true });
    }
    this.plugin.modeBus.emit(); // the sidebar follows the pane in front
  }
  onDataUpdated(): void { this.day.onDataUpdated(); this.week.onDataUpdated(); this.tl.onDataUpdated(); }
}
