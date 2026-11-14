import { Menu, TFile, setIcon } from "obsidian";
import { Panel } from "./panel";
import { safe } from "../safe";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { openFileSmart } from "../openfile";
import { Task, Ticket, allTasks, allTickets, dayTask, prefixOf, readTask, restTask, sendPiece, setDone, sortTasks, ticketPathOf } from "../model";
import { assignProjectLinked, assignTicketLinked } from "../links";
import { PROJECT_PROP, Project, allProjects, projectPathOf } from "../projects";
import { sessionDays } from "../sessions";
import { readProp } from "../taskprops";
import { BACKLOG_COLS, BOARD_COLS, backlogOf, columnOf, doneThisWeek, lanes } from "../tasksboard";
import { Horizon, fmtDur, horizonTarget, parseYmd, startOfWeek, today } from "../util";
import { bindZone, renderTaskCard } from "./common";
import { renderHeadTitle, renderSwitch } from "./plannerHead";
import { NoteText } from "./search";
import { addTaskInput } from "./weekColumn";

type Mode = "board" | "backlog";
type Group = "none" | "project" | "ticket";
interface Item { t: Task; col: string; }
interface ColDef { key: string; label: string; }
interface Hooks {
  /** a card dropped on a column */ drop(col: string, path: string, i: import("../dnd").DropInfo): void | Promise<void>;
  /** the quick actions of a card */ actions(it: Item): Array<[string, () => void]>;
  /** properties of a task added at the foot of a column (flat view); null = the column takes no new tasks */ add(col: string, count: number): Record<string, string | number> | null;
  /** properties of a task added to a swimlane */ addLane(): Record<string, string | number>;
  /** a short label above a card ("Fri 13") */ dayLabel(t: Task, col: string): string | undefined;
  tones: Record<string, string>;
}

/** What the view was showing, kept for the session: opening a task replaces the view, and going back must land on the same tab, grouping and search. */
const memory = { mode: "board" as Mode, group: "none" as Group, query: "", collapsed: new Set<string>(), adding: null as string | null };

/**
 * The Tasks page, built like the Meetings page: a heading with the title over a muted line, search and switches on the right, then a quiet body.
 * Board: what is on your plate right now, as columns Overdue · Today · This week · Later · Done. Backlog: what is parked, as the columns of the week plan.
 * Both can be cut into swimlanes by project or by ticket; dropping a card in another lane moves it to that project / ticket.
 */
export class TasksView extends Panel {
  private root: HTMLElement;
  private scope = new DndScope();
  private pending = false;
  private texts = new NoteText(this.app);
  private timer = 0;

  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin, () => prefixOf(plugin.settings.tasksPath));
    this.root = parentEl.createDiv("samaya-tk");
    this.register(plugin.bus.on(() => this.schedule())); // a focus started or stopped: the task moves to In Progress
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
  }
  onunload() { this.texts.clear(); window.clearTimeout(this.timer); this.scope.dispose(); }
  protected visibleEl(): HTMLElement { return this.root; }
  onDataUpdated(): void { this.schedule(); }
  private schedule() {
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 30);
  }

  private render() {
    const s = this.plugin.settings, app = this.app, td = today(), wk = startOfWeek(td);
    const sc = this.root.querySelector<HTMLElement>(".samaya-tk-scroll"); const keep = sc ? { x: sc.scrollLeft, y: sc.scrollTop } : null;
    const cellY = new Map<string, number>(); this.root.querySelectorAll<HTMLElement>(".samaya-tk-cell[data-key]").forEach(c => cellY.set(c.dataset.key!, c.scrollTop));
    this.root.empty(); this.scope.clear();

    const tickets = new Map<string, Ticket>(allTickets(app, s).map(t => [t.file.path, t]));
    const projects = new Map<string, Project>(allProjects(app, s).map(p => [p.file.path, p]));
    const canTicket = s.ticketsOn || tickets.size > 0, canProject = s.projectsOn;
    if ((memory.group === "ticket" && !canTicket) || (memory.group === "project" && !canProject)) memory.group = "none";
    const laneOf = (t: Task) => memory.group === "ticket" ? ticketPathOf(app, t) : memory.group === "project" ? projectPathOf(app, t.file) : "";
    const laneLabel = (k: string) => memory.group === "ticket" ? tickets.get(k)?.key ?? k : projects.get(k)?.name ?? k;
    this.root.toggleClass("by-ticket", memory.group === "ticket"); this.root.toggleClass("by-project", memory.group === "project");

    // ---- the work, each piece in its column
    const all = allTasks(app, s);
    const everything = this.collect(all, td, wk);
    const backlog = (c: string) => c !== "overdue" && c !== "today" && c !== "progress" && c !== "done";
    let items = everything.filter(it => memory.mode === "board" ? !backlog(it.col) : backlog(it.col));
    const cols: ColDef[] = (memory.mode === "board" ? BOARD_COLS : BACKLOG_COLS).map(([key, label]) => ({ key, label }));
    const q = memory.query.trim().toLowerCase();
    if (q) { this.readTicketNotes([...tickets.values()]); items = items.filter(it => this.text(it.t, tickets, projects).includes(q)); }

    this.head(items, canTicket, canProject, tickets.size > 0 || s.ticketsOn);
    const scroll = this.root.createDiv("samaya-tk-scroll" + (memory.group === "none" ? " is-flat" : "")); const grid = scroll.createDiv("samaya-tk-grid"); grid.style.setProperty("--cols", String(cols.length));
    const hooks = memory.mode === "board" ? this.boardHooks(td) : this.backlogHooks(td);

    const hd = grid.createDiv("samaya-tk-cols");
    for (const c of cols) {
      const mine = items.filter(it => it.col === c.key); const est = c.key === "done" ? 0 : mine.reduce((a, it) => a + it.t.estimate, 0);
      const h = hd.createDiv({ cls: `samaya-tk-colhead is-${hooks.tones[c.key] ?? "plain"}` });
      h.createSpan({ cls: "samaya-tk-collabel", text: c.label }); h.createSpan({ cls: "samaya-tk-colcount", text: String(mine.length) });
      if (est) h.createSpan({ cls: "samaya-tk-colest", text: fmtDur(est) });
    }

    const grouped = memory.group !== "none";
    const ls = grouped ? lanes(items, it => laneOf(it.t), laneLabel) : [{ key: "", items }];
    if (!items.length) grid.createDiv({ cls: "samaya-tk-none", text: q ? "No tasks match." : memory.mode === "board" ? "Nothing going on. Plan a task for today from the backlog." : "The backlog is empty." });
    for (const lane of ls) {
      const box = grid.createDiv({ cls: "samaya-tk-lane" + (grouped ? "" : " is-only") });
      const lkey = `${memory.group}|${lane.key}`; const closed = grouped && memory.collapsed.has(lkey);
      if (grouped) this.laneHead(box, lane.key, lane.items, lkey, closed, tickets, projects, hooks);
      if (closed) continue;
      const row = box.createDiv("samaya-tk-row");
      for (const c of cols) {
        const cell = row.createDiv({ cls: `samaya-tk-cell is-${hooks.tones[c.key] ?? "plain"}` }); cell.dataset.key = `${memory.mode}|${lane.key}|${c.key}`;
        const mine = lane.items.filter(it => it.col === c.key);
        bindZone(this.scope, cell, (path, i) => { void this.dropped(hooks, c.key, path, i, grouped ? lane.key : null, tickets, projects); });
        if (!grouped) { const p = hooks.add(c.key, mine.length); if (p) addTaskInput(this.plugin, cell, "+ Add task", () => p, () => this.schedule()); }
        for (const it of mine) renderTaskCard(this.plugin, cell, it.t, { scope: this.scope, compact: true, dayLabel: hooks.dayLabel(it.t, c.key), actions: hooks.actions(it), ...(memory.mode === "board" && c.key === "today" ? { focus: "today" as const } : {}) });
        if (!mine.length) cell.createDiv({ cls: "samaya-tk-empty", text: c.key === "overdue" ? "All caught up" : c.key === "done" ? "Nothing finished yet" : c.key === "progress" ? "Start a task with its focus timer" : "Drop a task here" });
      }
    }
    if (keep) { scroll.scrollLeft = keep.x; scroll.scrollTop = keep.y; }
    scroll.querySelectorAll<HTMLElement>(".samaya-tk-cell[data-key]").forEach(c => { const y = cellY.get(c.dataset.key!); if (y) c.scrollTop = y; });
  }

  // ---- the board's pieces of work

  /** Every piece of work in its column. Board: overdue, today, in progress (the focus timer ran at least once), done this week. Backlog: the rest, by when it is due. */
  private collect(all: Task[], td: string, wk: string): Item[] {
    const out: Item[] = []; const focused = this.plugin.focus.state?.path;
    for (const t of sortTasks(all)) {
      const fm = (this.app.metadataCache.getFileCache(t.file)?.frontmatter ?? {}) as Record<string, unknown>;
      if (t.status === "done") {
        if (doneThisWeek(String(readProp(fm, "completed") ?? "").slice(0, 10), t.planned, wk)) out.push({ t, col: "done" });
        continue;
      }
      if (t.actual > 0 || focused === t.file.path || (Array.isArray(fm.focus_sessions) && fm.focus_sessions.length)) { out.push({ t, col: "progress" }); continue; }
      const days = sessionDays(t.sessions);
      const put = (x: Task, day: string, week: string) => out.push({ t: x, col: columnOf(day, week, td, wk) ?? backlogOf(day, week, t.horizon, t.later, td, wk) });
      for (const d of days) put(dayTask(t, d), d, "");
      if (!days.length) put(t, "", t.week); else if (t.rest > 0) put(restTask(t), "", t.week);
    }
    return out;
  }
  /** Ticket notes are searched by their text too: read in the background (once per change, a few at a time), then the search runs again. */
  private readTicketNotes(tickets: Ticket[]) { this.texts.load(tickets.map(t => t.file), () => { if (this.root.isConnected && memory.query.trim()) this.refilter(); }); }
  private refilter() { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { const had = !!this.root.querySelector("input.samaya-mt-search:focus"); this.render(); const el = this.root.querySelector<HTMLInputElement>(".samaya-mt-search"); if (had) { el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, 30); }
  private text(t: Task, tickets: Map<string, Ticket>, projects: Map<string, Project>): string {
    const tk = tickets.get(ticketPathOf(this.app, t)); const pr = projects.get(projectPathOf(this.app, t.file));
    return [t.title, t.channel, tk?.key, tk?.summary, pr?.name, tk ? this.texts.get(tk.file) : ""].filter(Boolean).join(" ").toLowerCase();
  }
  /** Where a card comes from, for sendPiece (a rest is "", a task on a day is that day). */
  private from = (t: Task) => ({ day: t.part?.kind === "rest" ? "" : t.planned || null, seg: null as number | null });

  private boardHooks(td: string): Hooks {
    const s = this.plugin.settings, app = this.app;
    const go = (t: Task) => { safe(sendPiece(app, s, t.file, this.from(t), { day: td }), "moving the task"); };
    const day = (d: string) => parseYmd(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    return {
      tones: { overdue: "warn", today: "accent", done: "done" },
      drop: async (col, path, i) => {
        const f = app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
        const t = readTask(app, f);
        if (col === "done") { if (t.status !== "done") await setDone(app, t, true); return; }
        if (col !== "today") return; // overdue and in progress are not places to put work: they follow from the dates and the timer
        const d = i.day ?? t.planned;
        if (t.status !== "done" && d === td) return; // already there
        if (t.status === "done") await setDone(app, t, false);
        await sendPiece(app, s, f, i, { day: td });
      },
      actions: it => it.col === "overdue" ? [["Today", () => go(it.t)]] : [],
      add: (col, n): Record<string, string | number> | null => col === "today" ? { planned: td, order: n } : null,
      addLane: () => ({ planned: td }),
      dayLabel: (t, col) => t.planned && t.part?.kind !== "rest" && col === "overdue" ? day(t.planned) : undefined,
    };
  }
  private backlogHooks(td: string): Hooks {
    const s = this.plugin.settings, app = this.app, wk = startOfWeek(td);
    const go = (t: Task, dest: Parameters<typeof sendPiece>[4]) => { safe(sendPiece(app, s, t.file, this.from(t), dest), "moving the task"); };
    const day = (d: string) => parseYmd(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    return {
      tones: {},
      drop: async (col, path, i) => {
        const f = app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
        const t = readTask(app, f); if (t.status === "done") await setDone(app, t, false);
        const d = i.day ?? t.planned; const here = backlogOf(d, d ? "" : t.week, t.horizon, t.later, td, wk);
        if (t.status !== "done" && here === col && (d || t.week || t.rest === 0)) return; // there already: re-parking would only reset its date
        await sendPiece(app, s, f, i, col === "thisweek" ? { week: wk } : { backlog: col as Horizon });
      },
      actions: it => [["Today", () => go(it.t, { day: td })], ...(it.col !== "thisweek" ? [["This week", () => go(it.t, { week: wk })] as [string, () => void]] : [])],
      add: (col): Record<string, string | number> => col === "thisweek" ? { week: wk } : { horizon: col, ...(horizonTarget(col as Horizon, td) ? { later: horizonTarget(col as Horizon, td) } : {}) },
      addLane: () => ({ horizon: "someday" }),
      dayLabel: (t, col) => t.planned && t.part?.kind !== "rest" && col !== "someday" ? day(t.planned) : undefined,
    };
  }

  /** A card dropped on a cell: it moves to the column and, in a swimlane view, to the lane's project / ticket. */
  private async dropped(hooks: Hooks, col: string, path: string, i: import("../dnd").DropInfo, lane: string | null, tickets: Map<string, Ticket>, projects: Map<string, Project>) {
    const f = this.app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
    await hooks.drop(col, path, i);
    if (lane === null) return;
    const t = readTask(this.app, f);
    if (memory.group === "ticket" && ticketPathOf(this.app, t) !== lane) await assignTicketLinked(this.app, this.plugin.settings, f, tickets.get(lane) ?? null);
    else if (memory.group === "project" && projectPathOf(this.app, f) !== lane) await assignProjectLinked(this.app, this.plugin.settings, f, projects.get(lane) ?? null);
  }

  // ---- heading

  /** Title over a muted line, then (right) the search, "Group by" and the Board | Backlog switch: the same bar as the planner and the meetings. */
  private head(items: Item[], canTicket: boolean, canProject: boolean, canSync: boolean) {
    const head = this.root.createDiv("samaya-week-head samaya-day-head samaya-tk-head");
    const open = items.filter(it => it.col !== "done"); const late = items.filter(it => it.col === "overdue").length;
    const sub = memory.mode === "board"
      ? [`${open.length} open`, late ? `${late} overdue` : "", items.some(it => it.col === "today") ? `${fmtDur(items.filter(it => it.col === "today").reduce((a, it) => a + it.t.estimate, 0))} today` : ""]
      : [`${items.length} in the backlog`, items.length ? fmtDur(items.reduce((a, it) => a + it.t.estimate, 0)) : ""];
    renderHeadTitle(head, "Tasks", sub.filter(Boolean).join(" · ") || " ");
    const right = head.createDiv("samaya-planner-right");

    const search = right.createEl("input", { cls: "samaya-mt-search", type: "search", placeholder: "Search tasks" }); search.value = memory.query;
    search.oninput = () => {
      memory.query = search.value; window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { this.render(); const el = this.root.querySelector<HTMLInputElement>(".samaya-mt-search"); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, 150);
    };
    if (canSync) {
      const b = right.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": "Sync Jira / GitLab tickets" } });
      setIcon(b, "refresh-cw"); b.onclick = () => { void this.plugin.syncTickets(); };
    }
    if (canTicket || canProject) {
      const g = right.createDiv("samaya-tk-group"); g.createSpan({ cls: "samaya-tk-grouplabel", text: "Group by" });
      const sides: Array<[Group, string, string]> = [["none", "None", "One list of columns"]];
      if (canProject) sides.push(["project", "Project", "One lane per project"]);
      if (canTicket) sides.push(["ticket", "Ticket", "One lane per ticket"]);
      renderSwitch<Group>(g, sides, memory.group, v => { memory.group = v; memory.adding = null; this.render(); }, "Group tasks by");
    }
    renderSwitch<Mode>(right, [["board", "Board", "What is going on: overdue, today, in progress, done"], ["backlog", "Backlog", "What is parked for later"]], memory.mode, m => { memory.mode = m; memory.adding = null; this.render(); }, "Tasks view");
  }

  /** The header of a swimlane: ▾ name, what it holds, open / add. Click folds it. */
  private laneHead(box: HTMLElement, key: string, items: Item[], lkey: string, closed: boolean, tickets: Map<string, Ticket>, projects: Map<string, Project>, hooks: Hooks) {
    const app = this.app; const tk = memory.group === "ticket" ? tickets.get(key) : undefined; const pr = memory.group === "project" ? projects.get(key) : undefined;
    const h = box.createDiv({ cls: "samaya-tk-lanehead" + (closed ? " is-collapsed" : "") });
    setIcon(h.createSpan("samaya-tk-chevron"), "chevron-down");
    const name = h.createDiv("samaya-tk-lanename");
    if (!key) name.createSpan({ cls: "samaya-tk-lanekey is-none", text: memory.group === "ticket" ? "No ticket" : "No project" });
    else if (tk) { const chip = name.createSpan({ cls: `samaya-chip samaya-chip-ticket is-${tk.source}` }); setIcon(chip.createSpan({ cls: "samaya-chip-icon" }), "ticket"); chip.createSpan({ text: tk.key }); name.createSpan({ cls: "samaya-tk-lanesum", text: tk.summary }); }
    else { const k = name.createSpan({ cls: "samaya-tk-lanekey is-project" }); setIcon(k.createSpan({ cls: "samaya-chip-icon" }), "folder-kanban"); k.createSpan({ text: pr?.name ?? key.split("/").pop()!.replace(/\.md$/, "") }); }
    const open = items.filter(it => it.col !== "done"); const est = open.reduce((a, it) => a + it.t.estimate, 0);
    h.createSpan({ cls: "samaya-tk-lanecount", text: `${open.length} open${est ? " · " + fmtDur(est) : ""}` });
    h.onclick = () => { if (!memory.collapsed.delete(lkey)) memory.collapsed.add(lkey); this.render(); };

    const file = tk?.file ?? pr?.file;
    const act = h.createDiv("samaya-tk-laneacts");
    if (file) {
      const o = act.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": "Open note" } }); setIcon(o, "arrow-up-right");
      o.onclick = e => { e.stopPropagation(); if (tk?.url && (e.ctrlKey || e.metaKey) && e.shiftKey) { window.open(tk.url); return; } void openFileSmart(app, file, e.ctrlKey || e.metaKey ? "tab" : false); };
      o.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); const m = new Menu(); if (tk?.url) m.addItem(i => i.setTitle("Open in browser").setIcon("external-link").onClick(() => window.open(tk.url))); m.addItem(i => i.setTitle("Open note").setIcon("file").onClick(() => { void openFileSmart(app, file, "tab"); })); m.showAtMouseEvent(e); };
    }
    if (!key || file) {
      const plus = act.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": "Add a task to this lane" } }); setIcon(plus, "plus");
      plus.onclick = e => { e.stopPropagation(); memory.adding = memory.adding === lkey ? null : lkey; this.render(); };
    }
    if (memory.adding === lkey && !closed) {
      const where = memory.mode === "board" ? "today" : "Someday";
      const props = () => ({ ...hooks.addLane(), ...(tk ? { ticket: `[[${tk.file.basename}]]` } : {}), ...(pr ? { [PROJECT_PROP]: `[[${pr.file.basename}]]` } : {}) });
      const inp = addTaskInput(this.plugin, box, `+ Add to ${where}${tk ? ` for ${tk.key}` : pr ? ` in ${pr.name}` : ""}`, props, () => this.schedule());
      inp.addClass("samaya-tk-laneadd");
      inp.addEventListener("keydown", e => { if (e.key === "Escape") { memory.adding = null; this.render(); } });
      window.setTimeout(() => inp.focus(), 0);
    }
  }
}
