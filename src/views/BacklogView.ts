import { BasesView, Menu, QueryController, TFile } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, Ticket, allTickets, assignTicket, createTask, patchTask, readTask, sortTasks, ticketPathOf } from "../model";
import { fmtDur, parseTitleEstimate, startOfWeek, today } from "../util";
import { bindZone, renderTaskCard } from "./common";

export const BACKLOG_VIEW_TYPE = "samaya-backlog";

interface Group { key: string; ticket: Ticket | null; tasks: Task[]; }

export class BacklogView extends BasesView {
  readonly type = BACKLOG_VIEW_TYPE;
  private root: HTMLElement;
  private scope = new DndScope();
  private pending = false;
  private timer = 0;
  private filter = "";
  private collapsed = new Set<string>();

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    this.root = parentEl.createDiv("samaya-backlog-view"); this.plugin.showStatusSidebar(this.root);
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
  }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); }
  onDataUpdated(): void { this.schedule(); }
  private schedule() {
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 30);
  }

  private render() {
    const s = this.plugin.settings; const app = this.app;
    const scrollTop = this.root.querySelector<HTMLElement>(".samaya-groups")?.scrollTop ?? 0;
    const hadFocus = document.activeElement?.classList.contains("samaya-search");
    this.root.empty(); this.scope.clear();
    const hideEmpty = this.config.get("hideEmptyTickets") === true;
    const q = this.filter.toLowerCase();

    const head = this.root.createDiv("samaya-backlog-head");
    head.createEl("h2", { text: "Backlog" });
    const search = head.createEl("input", { type: "search", cls: "samaya-search", attr: { placeholder: "Filter…" } }); search.value = this.filter;
    search.addEventListener("input", () => { this.filter = search.value; this.render(); });
    if (s.jiraOn || s.gitlabOn) head.createEl("button", { text: "Sync tickets" }).onclick = () => { void this.plugin.syncTickets(); };

    const tickets = allTickets(app, s); const byPath = new Map(tickets.map(t => [t.file.path, t]));
    const tasks = sortTasks(this.data.data.map(e => readTask(app, e.file)).filter(t => !t.planned && t.status !== "done"));
    const groups = new Map<string, Group>();
    for (const tk of tickets) if (tk.state !== "closed") groups.set(tk.file.path, { key: tk.file.path, ticket: tk, tasks: [] });
    const none: Group = { key: "", ticket: null, tasks: [] };
    for (const t of tasks) {
      const p = ticketPathOf(app, t); const tk = byPath.get(p);
      if (!tk) { none.tasks.push(t); continue; }
      if (!groups.has(p)) groups.set(p, { key: p, ticket: tk, tasks: [] }); // closed ticket that still has tasks
      groups.get(p)!.tasks.push(t);
    }
    const match = (g: Group, t: Task) => !q || t.title.toLowerCase().includes(q) || (g.ticket && (g.ticket.key + " " + g.ticket.summary).toLowerCase().includes(q));
    const list = [...groups.values(), none];

    const wrap = this.root.createDiv("samaya-groups");
    for (const g of list) {
      const shown = g.tasks.filter(t => match(g, t));
      if (q && !shown.length && !(g.ticket && (g.ticket.key + g.ticket.summary).toLowerCase().includes(q))) continue;
      if (!g.ticket && q && !shown.length) continue;
      if (g.ticket && hideEmpty && !g.tasks.length) continue;
      this.group(wrap, g, shown);
    }
    if (!tasks.length && !tickets.length) wrap.createDiv({ cls: "samaya-empty", text: "Backlog is empty. Add tasks from the Daily Planner, or sync tickets from Jira/GitLab." });
    wrap.scrollTop = scrollTop;
    if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  private group(parent: HTMLElement, g: Group, shown: Task[]) {
    const app = this.app; const open = !this.collapsed.has(g.key);
    const box = parent.createDiv({ cls: "samaya-group" + (g.ticket ? "" : " is-none") });
    const h = box.createDiv("samaya-group-head");
    h.createSpan({ cls: "samaya-group-chev", text: open ? "▾" : "▸" });
    if (g.ticket) {
      h.createSpan({ cls: `samaya-badge is-${g.ticket.source}`, text: g.ticket.source === "jira" ? "Jira" : g.ticket.source === "gitlab" ? "GitLab" : "Ticket" });
      h.createSpan({ cls: "samaya-group-key", text: g.ticket.key });
      h.createSpan({ cls: "samaya-group-summary", text: g.ticket.summary });
      if (g.ticket.state) h.createSpan({ cls: "samaya-chip", text: g.ticket.state });
    } else h.createSpan({ cls: "samaya-group-key", text: "No ticket" });
    const total = g.tasks.reduce((a, t) => a + t.estimate, 0);
    h.createSpan({ cls: "samaya-group-count", text: `${g.tasks.length} · ${fmtDur(total)}` });
    if (g.ticket) {
      const tk = g.ticket;
      const more = h.createEl("button", { cls: "samaya-mini", text: "⋯" });
      more.addEventListener("click", e => {
        e.stopPropagation(); const m = new Menu();
        if (tk.url) m.addItem(i => i.setTitle("Open in browser").setIcon("external-link").onClick(() => window.open(tk.url)));
        m.addItem(i => i.setTitle("Open ticket note").setIcon("file").onClick(() => { void app.workspace.getLeaf("tab").openFile(tk.file); }));
        m.showAtMouseEvent(e);
      });
    }
    h.addEventListener("click", () => { if (open) this.collapsed.add(g.key); else this.collapsed.delete(g.key); this.render(); });
    if (!open) return;

    const body = box.createDiv("samaya-group-body");
    shown.forEach(t => renderTaskCard(this.plugin, body, t, {
      scope: this.scope,
      actions: [["Today", () => { void patchTask(app, t.file, { planned: today(), week: null }); }], ["Week", () => { void patchTask(app, t.file, { week: startOfWeek(today()) }); }]],
    }));
    if (!shown.length) body.createDiv({ cls: "samaya-empty", text: "No tasks - drop one here or add below." });
    // drop = assign to this ticket
    bindZone(this.scope, box, path => {
      const f = app.vault.getAbstractFileByPath(path); if (f instanceof TFile) void assignTicket(app, f, g.ticket);
    });
    const add = box.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder: g.ticket ? `+ Add task for ${g.ticket.key}` : "+ Add task" } });
    add.addEventListener("keydown", e => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      const p = parseTitleEstimate(add.value); add.value = "";
      void createTask(app, this.plugin.settings, p.title, {
        estimate: p.estimate ?? this.plugin.settings.defaultEstimate,
        ...(g.ticket ? { ticket: `[[${g.ticket.file.basename}]]` } : {}),
      });
    });
  }
}
