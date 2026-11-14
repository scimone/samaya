import { Panel } from "./panel";
import type SamayaPlugin from "../main";
import { openFileSmart } from "../openfile";
import { NO_PROJECT, groupTickets } from "../kanban";
import { DndScope } from "../dnd";
import { bindZone } from "./common";
import { Ticket, patchNote, prefixOf, readTicket, relocateTicket, varsOfTicket } from "../model";
import { TFile, setIcon } from "obsidian";
import { TextPromptModal } from "../modals";
import { createProject, projectPathOf } from "../projects";
import { linkProject } from "../links";
import { projectChip } from "./common";
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
  /** Ask for a name (pre-filled), create a project and link the given tickets to it. */
  private newProject(initial: string, tickets: Ticket[], ticketProject?: string) {
    new TextPromptModal(this.plugin, "New project name", n => { void createProject(this.app, this.plugin.settings, n).then(f => linkProject(this.app, this.plugin.settings, f, tickets, ticketProject)).then(() => this.plugin.bus.emit()); }, initial).open();
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
    if (s.ticketsOn || all.length) {
      const b = right.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": "Sync Jira / GitLab tickets" } });
      setIcon(b, "refresh-cw"); b.onclick = () => { void this.plugin.syncTickets(); };
    }
    if (!all.length) { this.root.createDiv({ cls: "samaya-empty", text: "No tickets yet. Import them from Jira or GitLab (Sync tickets)." }); return; }
    const projectOf0 = (t: Ticket): TFile | null => { const f = this.app.vault.getAbstractFileByPath(projectPathOf(this.app, t.file)); return f instanceof TFile ? f : null; };
    const linked = (t: { file: TFile }) => !!projectPathOf(this.app, t.file);
    const { columns } = groupTickets(all); const { lanes } = groupTickets(tickets); // the columns stay whatever the search finds
    if (!tickets.length) this.root.createDiv({ cls: "samaya-empty", text: "No tickets match." });
    const scroll = this.root.createDiv("samaya-kb-scroll");
    const grid = scroll.createDiv("samaya-kb-grid"); grid.style.setProperty("--cols", String(columns.length));
    const head = grid.createDiv("samaya-kb-cols");
    for (const c of columns) head.createDiv({ cls: "samaya-kb-colhead", text: `${c} (${tickets.filter(t => (t.state || "No status") === c).length})` });
    for (const lane of lanes) {
      const box = grid.createDiv("samaya-kb-lane");
      const title = box.createDiv({ cls: "samaya-kb-lanehead" + (this.collapsed.has(lane.project) ? " is-collapsed" : "") });
      title.createSpan({ cls: "samaya-kb-chevron", text: "▾" }); title.createSpan({ text: lane.project }); title.createSpan({ cls: "samaya-kb-count", text: String(lane.count) });
      const projectOf = (t: Ticket) => projectPathOf(this.app, t.file);
      const laneProjects = new Set(all.filter(t => t.project === lane.project).map(projectOf).filter(Boolean));
      for (const pp of laneProjects) { // projects created from this Jira / GitLab project
        const pf = this.app.vault.getAbstractFileByPath(pp); if (!(pf instanceof TFile)) continue;
        if (String(this.app.metadataCache.getFileCache(pf)?.frontmatter?.ticket_project ?? "") !== lane.project) continue;
        const chip = projectChip(title.createSpan("samaya-card-meta samaya-kb-projectchip"), pf.basename); chip.addClass("is-link");
        chip.onclick = e => { e.stopPropagation(); openFileSmart(this.app, pf); };
      }
      const open = all.filter(t => t.project === lane.project && !linked(t));
      if (s.projectsOn && lane.project !== NO_PROJECT && open.length) {
        const add = title.createSpan({ cls: "samaya-kb-addproject", attr: { "aria-label": `Create a project from ${lane.project}` } }); setIcon(add, "folder-plus");
        add.onclick = e => { e.stopPropagation(); this.newProject(lane.project, open, lane.project); };
      }
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
          const pp = s.projectsOn ? projectOf0(t) : null;
          if (pp) { const chip = projectChip(card.createDiv("samaya-card-meta samaya-kb-projectchip"), pp.basename); chip.addClass("is-link"); chip.onclick = e => { e.stopPropagation(); openFileSmart(this.app, pp); }; }
          const meta = [t.issueType, t.assignee].filter(Boolean).join(" · "); if (meta) card.createDiv({ cls: "samaya-kb-meta", text: meta });
          this.scope.draggable(card, t.file.path);
          const acts = card.createDiv("samaya-kb-cardactions");
          const addTask = acts.createSpan({ cls: "samaya-kb-cardbtn", attr: { "aria-label": "Create a task from this ticket" } }); setIcon(addTask, "circle-check");
          addTask.onclick = e => { e.stopPropagation(); this.plugin.newTaskForTicket(t); };
          if (s.projectsOn && !linked(t)) {
            const add = acts.createSpan({ cls: "samaya-kb-cardbtn", attr: { "aria-label": "Create a project from this ticket" } }); setIcon(add, "folder-plus");
            add.onclick = e => { e.stopPropagation(); this.newProject(t.summary || t.key, [t]); };
          }
          card.onclick = e => { void openFileSmart(this.app, t.file, e.ctrlKey || e.metaKey ? "tab" : false); };
        }
      }
    }
    if (keep) { scroll.scrollLeft = keep.x; scroll.scrollTop = keep.y; }
  }
}
