import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { startOfWeek, today } from "../util";
import { DailyPlannerView } from "./DailyPlannerView";
import { WeeklyBoardView } from "./WeeklyBoardView";
import { WeeklyTimelineView } from "./WeeklyTimelineView";
import { renderWeekHead } from "./plannerHead";
import { DashboardPanel } from "./DashboardView";

export const PLANNER_VIEW_TYPE = "samaya-planner";

type Mode = "day" | "week" | "expanded" | "worktime";
type Layout = "split" | "timeline" | "board";

/**
 * The Planner: the day planner; the expanded week (timeline with the task board under it, one scrolling page); and the week guide
 * ("Plan week"), which takes over while it runs. In the expanded week both panes stay rendered: the layouts only collapse one of them
 * (a CSS height transition), so switching never redraws anything.
 */
export class PlannerView extends ItemView {
  private rootEl!: HTMLElement;
  private dayPane!: HTMLElement;
  private weekPane!: HTMLElement; // the task board (and the week guide)
  private tlPane!: HTMLElement;
  private headEl!: HTMLElement; // the week heading: one for the whole expanded week, so it never moves when the layout changes
  private wtPane!: HTMLElement; // the work time dashboard
  private wt!: DashboardPanel;
  private bar!: HTMLElement; // between the panes
  private day!: DailyPlannerView;
  private week!: WeeklyBoardView;
  private tl!: WeeklyTimelineView;
  private shown: Mode = "day";
  private shownLayout: Layout = "split";
  private seenH = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: SamayaPlugin) { super(leaf); }
  getViewType() { return PLANNER_VIEW_TYPE; }
  getDisplayText() { return "Planner"; }
  getIcon() { return "calendar-clock"; }

  async onOpen() {
    const plugin = this.plugin; const parentEl = this.contentEl; parentEl.empty();
    const root = this.rootEl = parentEl.createDiv("samaya-planner");
    this.headEl = root.createDiv("samaya-week-head samaya-planner-head");
    this.dayPane = root.createDiv("samaya-planner-pane");
    this.tlPane = root.createDiv("samaya-planner-pane");
    this.bar = root.createDiv("samaya-splitbar");
    this.weekPane = root.createDiv("samaya-planner-pane");
    this.wtPane = root.createDiv("samaya-planner-pane samaya-wt-pane is-hidden");
    this.wt = new DashboardPanel(plugin, this.wtPane.createDiv(), () => plugin.hideWorkTime());
    const sync = (w: string) => { this.tl.showWeekOf(w); this.week.showWeekOf(w); this.renderHead(); };
    this.day = new DailyPlannerView(this.dayPane, plugin, { hidden: () => this.mode() !== "day" });
    this.week = new WeeklyBoardView(this.weekPane, plugin, {
      hidden: () => this.mode() === "day" || this.mode() === "worktime", openDay: d => { this.day.goTo(d); plugin.collapseTimeline(); }, back: () => plugin.collapseTimeline(), weekChanged: sync,
      aligned: () => this.mode() === "expanded",
    });
    this.tl = new WeeklyTimelineView(this.tlPane, plugin, {
      hidden: () => this.mode() !== "expanded", layout: () => this.plugin.weekLayout, flow: () => this.mode() === "expanded", viewH: () => this.rootEl.clientHeight - this.headEl.offsetHeight, barH: () => this.bar.offsetHeight,
      back: () => plugin.collapseTimeline(), weekChanged: sync, openDay: d => { this.day.goTo(d); plugin.collapseTimeline(); },
    });
    for (const c of [this.day, this.week, this.tl]) this.addChild(c);
    const ro = new ResizeObserver(() => { if (this.shown === "expanded" && this.rootEl.clientHeight !== this.seenH) { this.seenH = this.rootEl.clientHeight; this.tl.refresh(); } }); // the hours follow the window
    ro.observe(this.rootEl); this.register(() => ro.disconnect());
    const hro = new ResizeObserver(() => { this.rootEl.style.setProperty("--wk-head", `${this.headEl.getBoundingClientRect().height}px`); }); // the arrow bar sticks exactly under the heading, whenever the heading fills in or resizes
    hro.observe(this.headEl); this.register(() => hro.disconnect());
    this.shown = this.mode(); this.shownLayout = plugin.weekLayout; this.applyMode(false);
    const mc = plugin.app.metadataCache, vault = plugin.app.vault; let tm = 0; // tasks changed, created, moved or deleted: the panes read them from the vault
    const touched = () => { window.clearTimeout(tm); tm = window.setTimeout(() => this.onDataUpdated(), 150); };
    this.registerEvent(mc.on("changed", touched)); this.registerEvent(mc.on("deleted", touched));
    this.registerEvent(vault.on("create", touched)); this.registerEvent(vault.on("rename", touched)); this.registerEvent(vault.on("delete", touched));
    this.register(() => window.clearTimeout(tm));
    this.register(() => this.wt.dispose());
    this.register(plugin.bus.on(() => { if (this.shown === "worktime") this.wt.schedule(); }));
    this.registerEvent(plugin.app.metadataCache.on("changed", () => { if (this.shown === "worktime") this.wt.schedule(); }));
    this.registerInterval(window.setInterval(() => { if (this.shown === "worktime") this.wt.render(); }, 30000));
    this.register(plugin.bus.on(() => {
      const m = this.mode(), l = plugin.weekLayout;
      if (m === this.shown && l === this.shownLayout) return;
      const prev = this.shown; this.shown = m; this.shownLayout = l;
      this.applyMode(prev === "expanded" && m === "expanded"); // layout change inside the expanded week: animated, nothing is redrawn
      if (m === "expanded" && prev !== "expanded") { const wk = plugin.weekToShow || plugin.plannerDate || today(); plugin.weekToShow = ""; this.tl.showWeekOf(wk); this.week.showWeekOf(wk); this.renderHead(); }
      else if (m === "worktime") this.wt.render();
      else if (m !== "expanded") this.active().refresh();
    }));
    this.registerDomEvent(document, "keydown", e => { // Esc folds the expanded week back
      if (e.key !== "Escape" || (this.mode() !== "expanded" && this.mode() !== "worktime") || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null; if (t && (t.closest("input, textarea, [contenteditable=true]") || document.querySelector(".modal-container"))) return;
      if (this.mode() === "worktime") plugin.hideWorkTime(); else plugin.collapseTimeline();
    });
    this.onDataUpdated(); // the first draw (Bases used to trigger it)
  }
  async onClose() { this.plugin.workTimeOpen = false; if (this.plugin.timelineWide) this.plugin.collapseTimeline(); } // closing the tab must not leave the sidebars folded

  private mode(): Mode {
    if (this.plugin.guide) this.plugin.workTimeOpen = false; // a guide takes the planner over
    return this.plugin.guide?.kind === "week" ? "week" : this.plugin.workTimeOpen ? "worktime" : this.plugin.timelineWide ? "expanded" : "day";
  }
  private active() { const m = this.mode(); return m === "week" ? this.week : m === "expanded" ? this.tl : this.day; }

  /** The bars between timeline and board: arrows that move the divider. Up gives the board more room, down the timeline.
   *  Both: ▲ ▼ (either view can take over) · Timeline only: ▲ (bring the board back) · Board only: ▼ (bring the timeline back). */
  /** The week heading, once, above both panes: [‹ Nov 9 – 15 ›] Week 46 · [↺ This week] (only when another week is showing) · Day | Week. */
  private renderHead() {
    const h = this.headEl; h.empty();
    renderWeekHead(h, this.tl.getWeek(), w => { this.tl.showWeekOf(w); this.week.showWeekOf(w); this.renderHead(); }, () => this.plugin.collapseTimeline(), this.plugin);
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
    this.weekPane.toggleClass("is-hidden", this.shown === "day" || this.shown === "worktime");
    this.wtPane.toggleClass("is-hidden", this.shown !== "worktime"); if (this.shown === "worktime") this.wt.render();
    this.tlPane.toggleClass("is-collapsed", ex && l === "board"); // the other pane takes its room; CSS animates the height
    this.weekPane.toggleClass("is-collapsed", ex && l === "timeline");
    this.renderBars(); this.setDays();
    if (animate) this.tl.fit(); // the hours stretch or shrink with the layout
    if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const b of [this.bar]) b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 120, fill: "backwards" });
    }
    this.plugin.modeBus.emit(); // the sidebar follows the pane in front
  }
  private setDays() { this.rootEl.style.setProperty("--wk-days", this.plugin.settings.plannerWeekends ? "7" : "5"); } // the column lines run through the arrow bar
  /** Settings changed or tasks changed: redraw every pane. */
  onDataUpdated(): void { this.setDays(); this.day.onDataUpdated(); this.week.onDataUpdated(); this.tl.onDataUpdated(); }
}
