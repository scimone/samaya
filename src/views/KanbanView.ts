import { Panel } from "./panel";
import type SamayaPlugin from "../main";
import { openFileSmart } from "../openfile";
import { groupTickets } from "../kanban";
import { DndScope } from "../dnd";
import { bindZone } from "./common";
import { patchNote, prefixOf, readTicket, relocateTicket, varsOfTicket } from "../model";
import { TFile, setIcon } from "obsidian";
import { renderHeadTitle } from "./plannerHead";
import { NoteText, matches, renderSearch } from "./search";

const memory = { query: "" };

export const KANBAN_VIEW_TYPE = "samaya-kanban";

/** Board of ticket notes: columns are statuses, one swimlane per Jira / GitLab project. Drag a card to another column to set its status (until the next sync, which restores the remote status). */
export class KanbanView extends Panel {
  private root: HTMLElement;
  private timer = 0;
  private collapsed = new Set<string>();
  private scope = new DndScope();
  private pending = false;
  private texts: NoteText;
  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) { super(plugin, () => prefixOf(plugin.settings.ticketsPath)); this.texts = new NoteText(this.app); this.root = parentEl.createDiv("samaya-kanban"); this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.render(); } }; }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); }
  private async setStatus(path: string, status: string) {
    const f = this.app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
    const t = readTicket(this.app, f); if (t.state === status || status === "No status") return;
    await patchNote(this.app, f, { status });
    if (this.plugin.settings.ticketsPath.includes("TICKET_STATUS")) await relocateTicket(this.app, this.plugin.settings, t, { ...varsOfTicket(t), status });
  }
  onDataUpdated(): void {
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 30); }

  private render() {
    const all = this.data.data.filter(e => e.file.extension === "md").map(e => readTicket(this.app, e.file))
      .filter(t => this.config.get("hideDone") !== true || !/(done|closed|resolved)/i.test(t.state));
    const q = memory.query.trim();
    if (q) this.texts.load(all.map(t => t.file), () => { if (this.root.isConnected && memory.query.trim()) this.onDataUpdated(); });
    const tickets = q ? all.filter(t => matches([t.key, t.summary, t.file.basename, t.project, t.assignee, t.issueType, t.state].filter(Boolean).join(" ").toLowerCase() + " " + this.texts.get(t.file), q)) : all;
    const prev = this.root.querySelector<HTMLElement>(".samaya-kb-scroll"); const keep = prev ? { x: prev.scrollLeft, y: prev.scrollTop } : null;
    this.root.empty(); this.scope.clear();
    const head0 = this.root.createDiv("samaya-week-head samaya-day-head samaya-kb-head");
    renderHeadTitle(head0, "Tickets", `${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"}`);
    const s = this.plugin.settings;
    const right = head0.createDiv("samaya-planner-right");
    if (all.length) renderSearch(right, "Search tickets", memory.query, v => { memory.query = v; }, () => this.render(), id => { this.timer = id; });
    if (s.jiraOn || s.gitlabOn || all.length) {
      const b = right.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": "Sync tickets", title: "Sync Jira / GitLab tickets" } });
      setIcon(b, "refresh-cw"); b.onclick = () => { void this.plugin.syncTickets(); };
    }
    if (!tickets.length) { this.root.createDiv({ cls: "samaya-empty", text: q ? "No tickets match." : "No tickets yet. Import them from Jira or GitLab (Sync tickets)." }); return; }
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
        bindZone(this.scope, cell, path => { void this.setStatus(path, c); });
        for (const t of lane.cells.get(c) ?? []) {
          const card = cell.createDiv("samaya-kb-card");
          card.createSpan({ cls: `samaya-chip samaya-chip-ticket is-${t.source}`, text: t.key });
          card.createDiv({ cls: "samaya-kb-title", text: t.summary || t.file.basename });
          const meta = [t.issueType, t.assignee].filter(Boolean).join(" · "); if (meta) card.createDiv({ cls: "samaya-kb-meta", text: meta });
          this.scope.draggable(card, t.file.path);
          card.onclick = e => { void openFileSmart(this.app, t.file, e.ctrlKey || e.metaKey ? "tab" : false); };
        }
      }
    }
    if (keep) { scroll.scrollLeft = keep.x; scroll.scrollTop = keep.y; }
  }
}
