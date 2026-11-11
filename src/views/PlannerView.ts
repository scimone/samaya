import { BasesView, QueryController, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { today } from "../util";
import { DailyPlannerView, DAILY_VIEW_TYPE } from "./DailyPlannerView";
import { WeeklyBoardView } from "./WeeklyBoardView";
import { WeeklyTimelineView } from "./WeeklyTimelineView";
import type { PlannerHost } from "./plannerHost";

export { DAILY_VIEW_TYPE as PLANNER_VIEW_TYPE }; // the id stays "samaya-daily" so existing planner bases keep working

type Mode = "day" | "week" | "expanded";
type Layout = "split" | "timeline" | "board";
/** The Planner: the day planner; the expanded week (timeline with the task board under it); and the week guide ("Plan week"), which takes over while it runs. */
export class PlannerView extends BasesView {
  readonly type = DAILY_VIEW_TYPE;
  private rootEl: HTMLElement;
  private dayPane: HTMLElement;
  private weekPane: HTMLElement; // the task board (and the week guide)
  private tlPane: HTMLElement;
  private bar: HTMLElement;
  private day: DailyPlannerView;
  private week: WeeklyBoardView;
  private tl: WeeklyTimelineView;
  private shown: Mode;
  private shownLayout: Layout;
  private seenH = 0;

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    const root = this.rootEl = parentEl.createDiv("samaya-planner");
    this.dayPane = root.createDiv("samaya-planner-pane");
    this.tlPane = root.createDiv("samaya-planner-pane");
    this.bar = root.createDiv("samaya-splitbar");
    this.weekPane = root.createDiv("samaya-planner-pane");
    const sync = (w: string) => { this.tl.showWeekOf(w); this.week.showWeekOf(w); };
    this.day = new DailyPlannerView(controller, this.dayPane, plugin, { hidden: () => this.mode() !== "day" });
    this.week = new WeeklyBoardView(controller, this.weekPane, plugin, {
      hidden: () => !this.boardShown(), placeBar: (root, head) => this.placeBar(root, head), back: () => plugin.collapseTimeline(), weekChanged: sync,
      flow: () => this.flow(),
    });
    this.tl = new WeeklyTimelineView(controller, this.tlPane, plugin, {
      hidden: () => !this.timelineShown(), flow: () => this.flow(), viewH: () => this.rootEl.clientHeight, back: () => plugin.collapseTimeline(), weekChanged: sync,
      openDay: d => { this.day.goTo(d); plugin.collapseTimeline(); },
    });
    for (const c of [this.day, this.week, this.tl]) { // the panes read the data and settings of this view
      Object.defineProperty(c, "data", { get: () => this.data, configurable: true });
      Object.defineProperty(c, "config", { get: () => this.config, configurable: true });
      Object.defineProperty(c, "allProperties", { get: () => this.allProperties, configurable: true });
      this.addChild(c);
    }
    const ro = new ResizeObserver(() => { if (this.flow() && this.rootEl.clientHeight !== this.seenH) { this.seenH = this.rootEl.clientHeight; this.tl.refresh(); } }); // the hours follow the window
    ro.observe(this.rootEl); this.register(() => ro.disconnect());
    this.shown = this.mode(); this.shownLayout = plugin.weekLayout; this.applyMode();
    this.register(plugin.bus.on(() => {
      const m = this.mode(), l = plugin.weekLayout;
      if (m === this.shown && l === this.shownLayout) return;
      const prev = this.shown; this.shown = m; this.shownLayout = l; this.applyMode();
      if (m === "expanded") { // the week follows you between the layouts
        if (prev === "expanded") { this.tl.refresh(); this.week.refresh(); } // just another layout: same week, same scroll position
        else { const wk = plugin.plannerDate || today(); this.tl.showWeekOf(wk); this.week.showWeekOf(wk); }
      } else this.active().refresh();
    }));
    this.registerDomEvent(document, "keydown", e => { // Esc folds the expanded week back
      if (e.key !== "Escape" || this.mode() !== "expanded" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null; if (t && (t.closest("input, textarea, [contenteditable=true]") || document.querySelector(".modal-container"))) return;
      plugin.collapseTimeline();
    });
  }
  onunload() { if (this.plugin.timelineWide) this.plugin.collapseTimeline(); } // closing the tab must not leave the sidebars folded

  private mode(): Mode { return this.plugin.guide?.kind === "week" ? "week" : this.plugin.timelineWide ? "expanded" : "day"; }
  private flow() { return this.mode() === "expanded" && this.plugin.weekLayout === "split"; }
  private timelineShown() { return this.mode() === "expanded" && this.plugin.weekLayout !== "board"; }
  private boardShown() { return this.mode() === "week" || (this.mode() === "expanded" && this.plugin.weekLayout !== "timeline"); }
  private active() { const m = this.mode(); return m === "week" ? this.week : m === "expanded" ? this.tl : this.day; }

  /** The bar between timeline and board: arrows that move the divider. Up gives the board more room, down the timeline.
   *  Both: ▲ ▼ (either view can take over) · Timeline only: ▲ (bring the board back) · Board only: ▼ (bring the timeline back). */
  private renderBar() {
    const l = this.shownLayout; this.bar.empty();
    const arrow = (dir: "up" | "down", to: Layout, hint: string) => {
      const b = this.bar.createEl("button", { cls: "samaya-splitarrow", attr: { title: hint, "aria-label": hint } });
      setIcon(b, dir === "up" ? "chevron-up" : "chevron-down"); b.onclick = () => { this.plugin.weekLayout = to; this.plugin.bus.emit(); };
    };
    if (l === "split") { arrow("up", "board", "Expand the task board (hide the timeline)"); arrow("down", "timeline", "Expand the timeline (hide the task board)"); }
    else if (l === "timeline") arrow("up", "split", "Show the task board under the timeline");
    else arrow("down", "split", "Show the timeline above the task board");
  }
  /** Board alone: the bar sits right under the week heading, inside the board. Otherwise it is the divider between the two panes. */
  private placeBar(root: HTMLElement, head: HTMLElement | null) {
    if (this.shown !== "expanded" || this.shownLayout !== "board") return;
    if (head) head.after(this.bar); else root.prepend(this.bar);
  }
  private applyMode() {
    const ex = this.shown === "expanded", l = this.shownLayout;
    this.rootEl.toggleClass("is-expanded", ex);
    this.dayPane.toggleClass("is-hidden", this.shown !== "day");
    this.tlPane.toggleClass("is-hidden", !(ex && l !== "board"));
    this.weekPane.toggleClass("is-hidden", !(this.shown === "week" || (ex && l !== "timeline")));
    this.rootEl.toggleClass("is-flow", ex && l === "split");
    this.bar.toggleClass("is-inline", ex && l === "board");
    this.renderBar();
    if (ex && l === "board") this.bar.detach(); // the board puts it under its heading when it renders
    else this.tlPane.after(this.bar);
    this.plugin.modeBus.emit(); // the sidebar follows the pane in front
  }
  onDataUpdated(): void { this.day.onDataUpdated(); this.week.onDataUpdated(); this.tl.onDataUpdated(); }
}
