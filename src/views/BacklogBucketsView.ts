import { Panel } from "./panel";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { allTasks, sortTasks, ticketPathOf, unplanned } from "../model";
import { startOfWeek, today } from "../util";
import { renderBacklogBuckets } from "./common";

export const BACKLOG_BUCKETS_VIEW_TYPE = "samaya-backlog-buckets";

/** The backlog grouped by when it is due: Next week / month / quarter / year, Someday, Never. Drag a task between groups to re-park it. Lives in the Tasks base; can be limited to tasks that belong to a ticket. */
export class BacklogBucketsView extends Panel {
  private root: HTMLElement;
  private scope = new DndScope();
  private pending = false;
  private timer = 0;

  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin);
    this.root = parentEl.createDiv("samaya-backlog-view samaya-bucketview");
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
    // the base only feeds tickets; tasks change on their own
    this.registerEvent(this.app.metadataCache.on("changed", () => this.schedule()));
    this.registerEvent(this.app.metadataCache.on("deleted", () => this.schedule()));
  }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); }
  onDataUpdated(): void { this.schedule(); }
  private schedule() {
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 150);
  }

  private render() {
    const keep = this.root.scrollTop;
    this.root.empty(); this.scope.clear();
    const onlyTicket = this.config.get("onlyWithTicket") === true; const wk = startOfWeek(today());
    const tasks = sortTasks(unplanned(allTasks(this.app, this.plugin.settings)).filter(t => t.status !== "done" && t.week !== wk && (!onlyTicket || !!ticketPathOf(this.app, t))));
    const head = this.root.createDiv("samaya-backlog-head");
    head.createEl("h2", { text: "Backlog by date" });
    renderBacklogBuckets(this.plugin, this.root.createDiv("samaya-buckets"), tasks, this.scope, {}, { label: "samaya-today-label", list: "samaya-bucket-list", empty: "samaya-empty" });
    this.root.scrollTop = keep;
  }
}
