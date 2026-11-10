import { BasesView, QueryController } from "obsidian";
import type SamayaPlugin from "../main";
import { DailyPlannerView, DAILY_VIEW_TYPE } from "./DailyPlannerView";
import { WeeklyBoardView } from "./WeeklyBoardView";
import type { PlannerHost } from "./plannerHost";

export { DAILY_VIEW_TYPE as PLANNER_VIEW_TYPE }; // the id stays "samaya-daily" so existing planner bases keep working

/** The Planner: the day planner and the week board in one view, switched with Day | Week (the week guide always shows the week). */
export class PlannerView extends BasesView {
  readonly type = DAILY_VIEW_TYPE;
  private dayPane: HTMLElement;
  private weekPane: HTMLElement;
  private day: DailyPlannerView;
  private week: WeeklyBoardView;
  private shown: "day" | "week";

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    const root = parentEl.createDiv("samaya-planner");
    this.dayPane = root.createDiv("samaya-planner-pane");
    this.weekPane = root.createDiv("samaya-planner-pane");
    const switcher = (parent: HTMLElement) => this.renderSwitch(parent);
    this.dayHost = { switcher, hidden: () => this.mode() !== "day" };
    this.weekHost = { switcher, hidden: () => this.mode() !== "week" };
    this.day = new DailyPlannerView(controller, this.dayPane, plugin, this.dayHost);
    this.week = new WeeklyBoardView(controller, this.weekPane, plugin, this.weekHost);
    for (const c of [this.day, this.week]) { // the panes read the data and settings of this view
      Object.defineProperty(c, "data", { get: () => this.data, configurable: true });
      Object.defineProperty(c, "config", { get: () => this.config, configurable: true });
      Object.defineProperty(c, "allProperties", { get: () => this.allProperties, configurable: true });
      this.addChild(c);
    }
    this.shown = this.mode(); this.applyMode();
    this.register(plugin.bus.on(() => { if (this.mode() !== this.shown) { this.shown = this.mode(); this.applyMode(); this.active().refresh(); } }));
  }
  private dayHost!: PlannerHost;
  private weekHost!: PlannerHost;

  private mode(): "day" | "week" { return this.plugin.guide ? (this.plugin.guide.kind === "week" ? "week" : "day") : this.plugin.plannerMode; }
  private active() { return this.mode() === "week" ? this.week : this.day; }
  private applyMode() {
    this.dayPane.toggleClass("is-hidden", this.shown !== "day");
    this.weekPane.toggleClass("is-hidden", this.shown !== "week");
    this.plugin.modeBus.emit(); // the sidebar follows the pane in front
  }
  private renderSwitch(parent: HTMLElement) {
    const box = parent.createDiv("samaya-modeswitch");
    (["day", "week"] as const).forEach(m => {
      const b = box.createEl("button", { text: m === "day" ? "Day" : "Week", cls: this.mode() === m ? "is-active" : "" });
      b.onclick = () => this.plugin.setPlannerMode(m);
    });
  }

  onDataUpdated(): void { this.day.onDataUpdated(); this.week.onDataUpdated(); }
}
