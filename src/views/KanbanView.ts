import { BasesView, QueryController } from "obsidian";
import type SamayaPlugin from "../main";
import { groupTickets } from "../kanban";
import { readTicket } from "../model";

export const KANBAN_VIEW_TYPE = "samaya-kanban";

/** Read-only board of ticket notes: columns are statuses, one swimlane per Jira / GitLab project. */
export class KanbanView extends BasesView {
  readonly type = KANBAN_VIEW_TYPE;
  private root: HTMLElement;
  private timer = 0;
  private collapsed = new Set<string>();
  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) { super(controller); this.root = parentEl.createDiv("samaya-kanban"); }
  onunload() { window.clearTimeout(this.timer); }
  onDataUpdated(): void { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 30); }

  private render() {
    const tickets = this.data.data.filter(e => e.file.extension === "md").map(e => readTicket(this.app, e.file))
      .filter(t => this.config.get("hideDone") !== true || !/(done|closed|resolved)/i.test(t.state));
    const prev = this.root.querySelector<HTMLElement>(".samaya-kb-scroll"); const keep = prev ? { x: prev.scrollLeft, y: prev.scrollTop } : null;
    this.root.empty();
    if (!tickets.length) { this.root.createDiv({ cls: "samaya-empty", text: "No tickets yet. Import them from Jira or GitLab (Sync tickets)." }); return; }
    const { columns, lanes } = groupTickets(tickets);
    const scroll = this.root.createDiv("samaya-kb-scroll");
    const grid = scroll.createDiv("samaya-kb-grid"); grid.style.setProperty("--cols", String(columns.length));
    const head = grid.createDiv("samaya-kb-cols");
    for (const c of columns) head.createDiv({ cls: "samaya-kb-colhead", text: `${c} (${tickets.filter(t => (t.state || "No status") === c).length})` });
    for (const lane of lanes) {
      const box = grid.createDiv("samaya-kb-lane");
      const title = box.createDiv({ cls: "samaya-kb-lanehead" + (this.collapsed.has(lane.project) ? " is-collapsed" : "") });
      title.createSpan({ cls: "samaya-kb-chevron", text: "▾" }); title.createSpan({ text: lane.project }); title.createSpan({ cls: "samaya-kb-count", text: String(lane.count) });
      title.onclick = () => { if (!this.collapsed.delete(lane.project)) this.collapsed.add(lane.project); this.render(); };
      if (this.collapsed.has(lane.project)) continue;
      const row = box.createDiv("samaya-kb-row");
      for (const c of columns) {
        const cell = row.createDiv("samaya-kb-cell");
        for (const t of lane.cells.get(c) ?? []) {
          const card = cell.createDiv("samaya-kb-card");
          card.createSpan({ cls: `samaya-chip samaya-chip-ticket is-${t.source}`, text: t.key });
          card.createDiv({ cls: "samaya-kb-title", text: t.summary || t.file.basename });
          const meta = [t.issueType, t.assignee].filter(Boolean).join(" · "); if (meta) card.createDiv({ cls: "samaya-kb-meta", text: meta });
          card.onclick = e => { void this.app.workspace.getLeaf(e.ctrlKey || e.metaKey ? "tab" : false).openFile(t.file); };
        }
      }
    }
    if (keep) { scroll.scrollLeft = keep.x; scroll.scrollTop = keep.y; }
  }
}
