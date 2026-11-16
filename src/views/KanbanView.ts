import { Panel } from "./panel";
import type SamayaPlugin from "../main";
import { safe } from "../safe";
import { openFileSmart } from "../openfile";
import { NO_PROJECT, applyColumnOrder, groupTickets, isDoneState, moveColumn, nestChildren } from "../kanban";
import { DndScope } from "../dnd";
import { bindZone } from "./common";
import { Ticket, allTasks, ticketPathOf, patchNote, prefixOf, readTicket, relocateTicket, varsOfTicket } from "../model";
import { TFile, setIcon } from "obsidian";
import { TextPromptModal, TicketSuggestModal } from "../modals";
import { createProject, projectPathOf, usecaseOf } from "../projects";
import { linkProject, ticketColorOf } from "../links";
import { projectChip, ticketProjectTitle } from "./common";
import { noteColor, tint } from "../itemcolor";
import { TICKET_SORTS, sortTickets } from "../sorting";
import { renderSort } from "./sortControl";
import { renderHeadTitle } from "./plannerHead";
import { NoteText, matches, renderSearch } from "./search";

const memory = { query: "" };
const COL_PREFIX = "samaya-col:"; // drag id of a column header (a ticket is dragged by its note path)

export const KANBAN_VIEW_TYPE = "samaya-kanban";

/** Board of ticket notes: columns are statuses, one swimlane per Jira / GitLab project. Drag a card to another column to set its status (until the next sync, which restores the remote status). */
export class KanbanView extends Panel {
  private root: HTMLElement;
  private timer = 0;
  private collapsed = new Set<string>();
  private scope = new DndScope();
  private pending = false;
  private texts: NoteText;
  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) { super(plugin, () => prefixOf(plugin.settings.ticketsPath)); this.texts = new NoteText(this.app); this.root = parentEl.createDiv("samaya-kanban"); this.redrawOnBus(); this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.render(); } }; }
  onunload() { this.texts.clear(); window.clearTimeout(this.timer); this.scope.dispose(); }
  private async setStatus(path: string, status: string) {
    const f = this.app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
    const t = readTicket(this.app, f); if (t.state === status || status === "No status") return;
    await patchNote(this.app, f, { status });
    if (this.plugin.settings.ticketsPath.includes("TICKET_STATUS")) await relocateTicket(this.app, this.plugin.settings, t, { ...varsOfTicket(t), status });
  }
  /** Ask for a name (pre-filled), create a project and link the given tickets to it. */
  private newProject(initial: string, tickets: Ticket[], ticketProject?: string) {
    new TextPromptModal(this.plugin, "New project name", n => { safe(createProject(this.app, this.plugin.settings, n).then(f => linkProject(this.app, this.plugin.settings, f, tickets, ticketProject)).then(() => this.plugin.bus.emit()), "creating the project"); }, initial).open();
  }
  /** Nest a ticket under a parent (or take it out again with null); the parent is stored by key in the ticket note. */
  private setParent(t: Ticket, parent: string | null) { safe(patchNote(this.app, t.file, { parent }).then(() => this.plugin.bus.emit()), "changing the parent ticket"); }
  private pickParent(t: Ticket) {
    new TicketSuggestModal(this.plugin, p => { if (p) this.setParent(t, p.key); }, p => p.file.path !== t.file.path && p.parent !== t.key, true, "Nest under parent ticket…").open();
  }
  protected visibleEl(): HTMLElement { return this.root; }
  onDataUpdated(): void {
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 30); }

  private render() {
    const all = this.data.data.filter(e => e.file.extension === "md").map(e => readTicket(this.app, e.file))
      .filter(t => this.config.get("hideDone") !== true || !isDoneState(t.state));
    const q = memory.query.trim();
    if (q) this.texts.load(all.map(t => t.file), () => { if (this.root.isConnected && memory.query.trim()) this.onDataUpdated(); });
    const tickets0 = q ? all.filter(t => matches([t.key, t.summary, t.file.basename, t.project, t.assignee, t.issueType, t.state].filter(Boolean).join(" ").toLowerCase() + " " + this.texts.get(t.file), q)) : all;
    const tickets = sortTickets(tickets0, this.plugin.settings.ticketsSort, this.plugin.settings.ticketsSortDesc, t => t.file.stat.ctime);
    const prev = this.root.querySelector<HTMLElement>(".samaya-kb-scroll"); const keep = prev ? { x: prev.scrollLeft, y: prev.scrollTop } : null;
    this.root.empty(); this.scope.clear();
    const head0 = this.root.createDiv("samaya-week-head samaya-day-head samaya-kb-head");
    renderHeadTitle(head0, "Tickets", `${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"}`);
    const s = this.plugin.settings;
    const right = head0.createDiv("samaya-planner-right");
    if (all.length) renderSearch(right, "Search tickets", memory.query, v => { memory.query = v; }, () => this.render(), id => { this.timer = id; });
    if (all.length) renderSort(right, TICKET_SORTS, s.ticketsSort, s.ticketsSortDesc, (key, d) => { s.ticketsSort = key; s.ticketsSortDesc = d; void this.plugin.saveSettings(); this.render(); });
    if (s.ticketsOn || all.length) {
      const b = right.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": "Sync Jira / GitLab tickets" } });
      setIcon(b, "refresh-cw"); b.onclick = () => { void this.plugin.syncTickets(); };
    }
    if (!all.length) { this.root.createDiv({ cls: "samaya-empty", text: "No tickets yet. Import them from Jira or GitLab (Sync tickets)." }); return; }
    const ppCache = new Map<string, string>(); // the project of each ticket, resolved once per draw
    const ppath = (f: TFile): string => { let v = ppCache.get(f.path); if (v === undefined) ppCache.set(f.path, v = projectPathOf(this.app, f)); return v; };
    const projectOf0 = (t: Ticket): TFile | null => { const f = this.app.vault.getAbstractFileByPath(ppath(t.file)); return f instanceof TFile ? f : null; };
    const linked = (t: { file: TFile }) => !!ppath(t.file);
    const perLane = new Map<string, Ticket[]>(); for (const t of all) (perLane.get(t.project) ?? perLane.set(t.project, []).get(t.project)!).push(t);
    const perState = new Map<string, number>(); for (const t of tickets) { const k = t.state || "No status"; perState.set(k, (perState.get(k) ?? 0) + 1); }
    const columns = applyColumnOrder(groupTickets(all).columns, s.ticketColumnOrder ?? []); // the columns stay whatever the search finds
    const nested = nestChildren(tickets); const { lanes } = groupTickets(nested.top); // a child ticket is shown inside its parent when both are on the board
    const taskStats = new Map<string, { done: number; total: number }>(); // tasks assigned to each ticket
    for (const tk of allTasks(this.app, s)) { const tp = ticketPathOf(this.app, tk); if (!tp) continue; const st = taskStats.get(tp) ?? { done: 0, total: 0 }; taskStats.set(tp, st); st.total++; if (tk.status === "done") st.done++; }
    const taskBadge = (el: HTMLElement, t: Ticket) => {
      const st = taskStats.get(t.file.path); if (!st) return;
      const b = el.createSpan({ cls: "samaya-kb-tasks" + (st.done === st.total ? " is-complete" : ""), attr: { "aria-label": `${st.done} of ${st.total} tasks done` } });
      setIcon(b.createSpan("samaya-kb-tasksicon"), "circle-check"); b.createSpan({ text: `${st.done}/${st.total}` });
    };
    if (!tickets.length) this.root.createDiv({ cls: "samaya-empty", text: "No tickets match." });
    const scroll = this.root.createDiv("samaya-kb-scroll");
    const grid = scroll.createDiv("samaya-kb-grid"); grid.style.setProperty("--cols", String(columns.length));
    const head = grid.createDiv("samaya-kb-cols");
    for (const c of columns) { // drag a column header onto another one to reorder the columns (kept for next time)
      const h = head.createDiv({ cls: "samaya-kb-colhead", text: `${c} (${perState.get(c) ?? 0})`, attr: { "aria-label": "Drag to reorder the columns" } });
      this.scope.draggable(h, COL_PREFIX + c);
      this.scope.target(h, { over: () => h.addClass("is-drop"), leave: () => h.removeClass("is-drop"), drop: i => {
        h.removeClass("is-drop"); if (!i.path.startsWith(COL_PREFIX)) return;
        const next = moveColumn(columns, i.path.slice(COL_PREFIX.length), c); if (next === columns) return;
        s.ticketColumnOrder = next; void this.plugin.saveSettings(); this.render();
      } });
    }
    for (const lane of lanes) {
      const box = grid.createDiv("samaya-kb-lane");
      const title = box.createDiv({ cls: "samaya-kb-lanehead" + (this.collapsed.has(lane.project) ? " is-collapsed" : "") });
      title.createSpan({ cls: "samaya-kb-chevron", text: "▾" }); if (lane.project === NO_PROJECT) title.createSpan({ text: lane.project }); else ticketProjectTitle(this.plugin, title, lane.project); title.createSpan({ cls: "samaya-kb-count", text: String(lane.count) });
      const laneAll = perLane.get(lane.project) ?? [];
      const laneProjects = new Set(laneAll.map(t => ppath(t.file)).filter(Boolean));
      for (const pp of laneProjects) { // projects created from this Jira / GitLab project
        const pf = this.app.vault.getAbstractFileByPath(pp); if (!(pf instanceof TFile)) continue;
        if (String(this.app.metadataCache.getFileCache(pf)?.frontmatter?.ticket_project ?? "") !== lane.project) continue;
        const chip = projectChip(title.createSpan("samaya-card-meta samaya-kb-projectchip"), pf.basename, noteColor(this.app, pf), usecaseOf(this.app, pf)); chip.addClass("is-link");
        chip.onclick = e => { e.stopPropagation(); openFileSmart(this.app, pf); };
      }
      const open = laneAll.filter(t => !linked(t));
      if (s.projectsOn && lane.project !== NO_PROJECT && open.length) {
        const add = title.createSpan({ cls: "samaya-kb-addproject", attr: { "aria-label": `Create a project from ${lane.project}` } }); setIcon(add, "folder-plus");
        add.onclick = e => { e.stopPropagation(); this.newProject(lane.project, open, lane.project); };
      }
      title.onclick = () => { if (!this.collapsed.delete(lane.project)) this.collapsed.add(lane.project); this.render(); };
      if (this.collapsed.has(lane.project)) continue;
      const row = box.createDiv("samaya-kb-row");
      for (const c of columns) {
        const cell = row.createDiv("samaya-kb-cell");
        bindZone(this.scope, cell, path => { safe(this.setStatus(path, c), "changing the status"); });
        for (const t of lane.cells.get(c) ?? []) {
          const card = cell.createDiv("samaya-kb-card");
          tint(card.createSpan({ cls: `samaya-chip samaya-chip-ticket is-${t.source}`, text: t.key }), ticketColorOf(this.app, s, t));
          card.createDiv({ cls: "samaya-kb-title", text: t.summary || t.file.basename });
          const pp = s.projectsOn ? projectOf0(t) : null;
          if (pp) { const chip = projectChip(card.createDiv("samaya-card-meta samaya-kb-projectchip"), pp.basename, noteColor(this.app, pp), usecaseOf(this.app, pp)); chip.addClass("is-link"); chip.onclick = e => { e.stopPropagation(); openFileSmart(this.app, pp); }; }
          const meta = [t.issueType, t.assignee].filter(Boolean).join(" · "); if (meta) card.createDiv({ cls: "samaya-kb-meta", text: meta });
          const kids = nested.kids.get(t.key) ?? [];
          const own = taskStats.get(t.file.path);
          if (own || kids.length) {
            const foot = card.createDiv("samaya-kb-foot"); taskBadge(foot, t);
            if (kids.length) { const kd = kids.filter(k => isDoneState(k.state)).length; foot.createSpan({ cls: "samaya-kb-kidcount", text: `${kd}/${kids.length} child tickets` }); }
          }
          if (kids.length) {
            const list = card.createDiv("samaya-kb-kids");
            for (const k of kids) {
              const row = list.createDiv({ cls: "samaya-kb-kid" + (isDoneState(k.state) ? " is-done" : "") });
              tint(row.createSpan({ cls: `samaya-chip samaya-chip-ticket is-${k.source}`, text: k.key }), ticketColorOf(this.app, s, k));
              row.createSpan({ cls: "samaya-kb-kidtitle", text: k.summary || k.file.basename });
              if (k.state) row.createSpan({ cls: "samaya-kb-kidstate", text: k.state });
              taskBadge(row, k);
              const un = row.createSpan({ cls: "samaya-kb-kidremove", attr: { "aria-label": "Remove from parent ticket" } }); setIcon(un, "x"); un.onclick = e => { e.stopPropagation(); this.setParent(k, null); };
              row.onclick = e => { e.stopPropagation(); void openFileSmart(this.app, k.file, e.ctrlKey || e.metaKey ? "tab" : false); };
            }
          }
          this.scope.draggable(card, t.file.path);
          const acts = card.createDiv("samaya-kb-cardactions");
          const addTask = acts.createSpan({ cls: "samaya-kb-cardbtn", attr: { "aria-label": "Create a task from this ticket" } }); setIcon(addTask, "circle-check");
          addTask.onclick = e => { e.stopPropagation(); this.plugin.newTaskForTicket(t); };
          const nest = acts.createSpan({ cls: "samaya-kb-cardbtn", attr: { "aria-label": t.parent ? `Change parent ticket (now ${t.parent})` : "Nest under a parent ticket" } }); setIcon(nest, "corner-down-right");
          nest.onclick = e => { e.stopPropagation(); this.pickParent(t); };
          if (t.parent) { const un = acts.createSpan({ cls: "samaya-kb-cardbtn", attr: { "aria-label": "Remove from parent ticket" } }); setIcon(un, "unlink"); un.onclick = e => { e.stopPropagation(); this.setParent(t, null); }; }
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
