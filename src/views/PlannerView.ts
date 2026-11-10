import { BasesView, QueryController } from "obsidian";
import type SamayaPlugin from "../main";
import { today } from "../util";
import { DailyPlannerView, DAILY_VIEW_TYPE } from "./DailyPlannerView";
import { WeeklyBoardView } from "./WeeklyBoardView";
import { WeeklyTimelineView } from "./WeeklyTimelineView";
import type { PlannerHost } from "./plannerHost";

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
  private shown: "day" | "week" | "timeline";

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    const root = parentEl.createDiv("samaya-planner");
    this.dayPane = root.createDiv("samaya-planner-pane");
    this.weekPane = root.createDiv("samaya-planner-pane");
    this.tlPane = root.createDiv("samaya-planner-pane");
    this.dayHost = { hidden: () => this.mode() !== "day" };
    this.weekHost = { hidden: () => this.mode() !== "week" };
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
    this.register(plugin.bus.on(() => { if (this.mode() !== this.shown) { this.shown = this.mode(); this.applyMode(); if (this.shown === "timeline") this.tl.showWeekOf(this.plugin.plannerDate || today()); else this.active().refresh(); } }));
    this.registerDomEvent(document, "keydown", e => { // Esc folds the expanded timeline back
      if (e.key !== "Escape" || this.mode() !== "timeline" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null; if (t && (t.closest("input, textarea, [contenteditable=true]") || document.querySelector(".modal-container"))) return;
      plugin.collapseTimeline();
    });
  }
  onunload() { if (this.plugin.timelineWide) this.plugin.collapseTimeline(); } // closing the tab must not leave the sidebars folded
  private dayHost!: PlannerHost;
  private weekHost!: PlannerHost;

  private mode(): "day" | "week" | "timeline" { return this.plugin.guide?.kind === "week" ? "week" : this.plugin.timelineWide ? "timeline" : "day"; }
  private active() { const m = this.mode(); return m === "week" ? this.week : m === "timeline" ? this.tl : this.day; }
  private applyMode() {
    this.dayPane.toggleClass("is-hidden", this.shown !== "day");
    this.weekPane.toggleClass("is-hidden", this.shown !== "week");
    this.tlPane.toggleClass("is-hidden", this.shown !== "timeline");
    this.plugin.modeBus.emit(); // the sidebar follows the pane in front
  }
  onDataUpdated(): void { this.day.onDataUpdated(); this.week.onDataUpdated(); this.tl.onDataUpdated(); }
}
