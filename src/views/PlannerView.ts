import { BasesView, QueryController, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { addDays, parseYmd, startOfWeek, today } from "../util";
import { DailyPlannerView, DAILY_VIEW_TYPE } from "./DailyPlannerView";
import { WeeklyBoardView } from "./WeeklyBoardView";
import { WeeklyTimelineView } from "./WeeklyTimelineView";

export { DAILY_VIEW_TYPE as PLANNER_VIEW_TYPE }; // the id stays "samaya-daily" so existing planner bases keep working

type Mode = "day" | "week" | "expanded";
type Layout = "split" | "timeline" | "board";

/**
 * The Planner: the day planner; the expanded week (timeline with the task board under it, one scrolling page); and the week guide
 * ("Plan week"), which takes over while it runs. In the expanded week both panes stay rendered: the layouts only collapse one of them
 * (a CSS height transition), so switching never redraws anything.
 */
export class PlannerView extends BasesView {
  readonly type = DAILY_VIEW_TYPE;
  private rootEl: HTMLElement;
  private dayPane: HTMLElement;
  private weekPane: HTMLElement; // the task board (and the week guide)
  private tlPane: HTMLElement;
  private headEl: HTMLElement; // the week heading: one for the whole expanded week, so it never moves when the layout changes
  private bar: HTMLElement; // between the panes
  private day: DailyPlannerView;
  private week: WeeklyBoardView;
  private tl: WeeklyTimelineView;
  private shown: Mode;
  private shownLayout: Layout;
  private seenH = 0;

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    const root = this.rootEl = parentEl.createDiv("samaya-planner");
    this.headEl = root.createDiv("samaya-week-head samaya-planner-head");
    this.dayPane = root.createDiv("samaya-planner-pane");
    this.tlPane = root.createDiv("samaya-planner-pane");
    this.bar = root.createDiv("samaya-splitbar");
    this.weekPane = root.createDiv("samaya-planner-pane");
    const sync = (w: string) => { this.tl.showWeekOf(w); this.week.showWeekOf(w); this.renderHead(); };
    this.day = new DailyPlannerView(controller, this.dayPane, plugin, { hidden: () => this.mode() !== "day" });
    this.week = new WeeklyBoardView(controller, this.weekPane, plugin, {
      hidden: () => this.mode() === "day", openDay: d => { this.day.goTo(d); plugin.collapseTimeline(); }, back: () => plugin.collapseTimeline(), weekChanged: sync,
      aligned: () => this.mode() === "expanded",
    });
    this.tl = new WeeklyTimelineView(controller, this.tlPane, plugin, {
      hidden: () => this.mode() !== "expanded", layout: () => this.plugin.weekLayout, flow: () => this.mode() === "expanded", viewH: () => this.rootEl.clientHeight - this.headEl.offsetHeight,
      back: () => plugin.collapseTimeline(), weekChanged: sync, openDay: d => { this.day.goTo(d); plugin.collapseTimeline(); },
    });
    for (const c of [this.day, this.week, this.tl]) { // the panes read the data and settings of this view
      Object.defineProperty(c, "data", { get: () => this.data, configurable: true });
      Object.defineProperty(c, "config", { get: () => this.config, configurable: true });
      Object.defineProperty(c, "allProperties", { get: () => this.allProperties, configurable: true });
      this.addChild(c);
    }
    const ro = new ResizeObserver(() => { if (this.shown === "expanded" && this.rootEl.clientHeight !== this.seenH) { this.seenH = this.rootEl.clientHeight; this.tl.refresh(); } }); // the hours follow the window
    ro.observe(this.rootEl); this.register(() => ro.disconnect());
    const hro = new ResizeObserver(() => { this.rootEl.style.setProperty("--wk-head", `${this.headEl.getBoundingClientRect().height}px`); }); // the arrow bar sticks exactly under the heading, whenever the heading fills in or resizes
    hro.observe(this.headEl); this.register(() => hro.disconnect());
    this.shown = this.mode(); this.shownLayout = plugin.weekLayout; this.applyMode(false);
    this.register(plugin.bus.on(() => {
      const m = this.mode(), l = plugin.weekLayout;
      if (m === this.shown && l === this.shownLayout) return;
      const prev = this.shown; this.shown = m; this.shownLayout = l;
      this.applyMode(prev === "expanded" && m === "expanded"); // layout change inside the expanded week: animated, nothing is redrawn
      if (m === "expanded" && prev !== "expanded") { const wk = plugin.plannerDate || today(); this.tl.showWeekOf(wk); this.week.showWeekOf(wk); this.renderHead(); }
      else if (m !== "expanded") this.active().refresh();
    }));
    this.registerDomEvent(document, "keydown", e => { // Esc folds the expanded week back
      if (e.key !== "Escape" || this.mode() !== "expanded" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null; if (t && (t.closest("input, textarea, [contenteditable=true]") || document.querySelector(".modal-container"))) return;
      plugin.collapseTimeline();
    });
  }
  onunload() { if (this.plugin.timelineWide) this.plugin.collapseTimeline(); } // closing the tab must not leave the sidebars folded

  private mode(): Mode { return this.plugin.guide?.kind === "week" ? "week" : this.plugin.timelineWide ? "expanded" : "day"; }
  private active() { const m = this.mode(); return m === "week" ? this.week : m === "expanded" ? this.tl : this.day; }

  /** The bars between timeline and board: arrows that move the divider. Up gives the board more room, down the timeline.
   *  Both: ▲ ▼ (either view can take over) · Timeline only: ▲ (bring the board back) · Board only: ▼ (bring the timeline back). */
  /** ‹ This week › and the Day | Week switch, once, above both panes. */
  private renderHead() {
    const h = this.headEl; h.empty(); const wk = this.tl.getWeek();
    const go = (w: string) => { this.tl.showWeekOf(w); this.week.showWeekOf(w); this.renderHead(); };
    h.createEl("button", { text: "‹" }).onclick = () => go(addDays(wk, -7));
    h.createEl("button", { text: "This week" }).onclick = () => go(startOfWeek(today()));
    h.createEl("button", { text: "›" }).onclick = () => go(addDays(wk, 7));
    const fmt = (x: string) => parseYmd(x).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    h.createEl("h2", { text: `${fmt(wk)} – ${fmt(addDays(wk, 6))}` });
    const sw = h.createDiv("samaya-modeswitch is-right");
    sw.createEl("button", { text: "Day", attr: { title: "Back to the day planner (Esc)" } }).onclick = () => this.plugin.collapseTimeline();
    sw.createEl("button", { text: "Week", cls: "is-active" });
  }

  private renderBars() {
    const l = this.shownLayout;
    for (const bar of [this.bar]) {
      bar.empty();
      const arrow = (dir: "up" | "down", to: Layout, text: string, hint: string) => {
        const b = bar.createEl("button", { cls: "samaya-splitarrow", attr: { title: hint, "aria-label": hint } });
        setIcon(b.createSpan("samaya-splitarrow-icon"), dir === "up" ? "chevron-up" : "chevron-down"); b.createSpan({ cls: "samaya-splitarrow-text", text });
        b.onclick = () => { this.plugin.weekLayout = to; this.plugin.bus.emit(); };
      };
      if (l === "split") { arrow("up", "board", "Expand tasks", "Expand the task board (hide the timeline)"); arrow("down", "timeline", "Expand timeline", "Expand the timeline (hide the task board)"); }
      else if (l === "timeline") arrow("up", "split", "Show tasks", "Show the task board under the timeline");
      else arrow("down", "split", "Show timeline", "Show the timeline above the task board");
    }
  }
  private applyMode(animate: boolean) {
    const ex = this.shown === "expanded", l = this.shownLayout;
    this.rootEl.toggleClass("is-expanded", ex);
    this.rootEl.toggleClass("is-board-only", ex && l === "board");
    this.rootEl.toggleClass("is-split", ex && l === "split");
    this.rootEl.toggleClass("is-timeline-only", ex && l === "timeline");
    this.dayPane.toggleClass("is-hidden", this.shown !== "day");
    this.tlPane.toggleClass("is-hidden", !ex);
    this.weekPane.toggleClass("is-hidden", this.shown === "day");
    this.tlPane.toggleClass("is-collapsed", ex && l === "board"); // the other pane takes its room; CSS animates the height
    this.weekPane.toggleClass("is-collapsed", ex && l === "timeline");
    this.renderBars();
    if (animate) this.tl.fit(); // the hours stretch or shrink with the layout
    if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const b of [this.bar]) b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 120, fill: "backwards" });
    }
    this.plugin.modeBus.emit(); // the sidebar follows the pane in front
  }
  onDataUpdated(): void { this.day.onDataUpdated(); this.week.onDataUpdated(); this.tl.onDataUpdated(); }
}
