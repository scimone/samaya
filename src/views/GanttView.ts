import { Menu, setIcon } from "obsidian";
import { Panel } from "./panel";
import { safe } from "../safe";
import type SamayaPlugin from "../main";
import { openFileSmart, openFileBeside } from "../openfile";
import { DragMode, GRANULARITIES, Granularity, collapseTasks, daysBetween, taskPeriod, taskSpan, dragSpan, ganttRange, granularityDayWidth, monthMarks } from "../gantt";
import { DEFAULT_PROJECT_DAYS, Project, projectStats, readProject, createProject, projectPathOf, projectsPrefix } from "../projects";
import { Task, Ticket, allTasks, allTickets, patchNote, prefixOf, setDone, ticketPathOf } from "../model";
import { linkProject } from "../links";
import { ConfirmDeleteModal, TextPromptModal, TicketTargetSuggestModal } from "../modals";
import { showTaskMenu } from "./common";
import { openRangePicker } from "./rangePicker";
import { renderHeadTitle } from "./plannerHead";
import { renderResetPill } from "./dateNav";
import { NoteText, matches, renderSearch } from "./search";

const memory = { query: "", back: 0, fwd: 0, open: new Set<string>(), all: new Set<string>() }; // extra weeks before / after the dates, grown by scrolling to either edge
import { addDays, horizonOf, parseYmd, today } from "../util";

const MIN_NAME_W = 120, MAX_NAME_W = 600, COLLAPSED_W = 36;
export const GANTT_VIEW_TYPE = "samaya-gantt";

export class GanttView extends Panel {
  private root: HTMLElement;
  private timer = 0;
  private dragging = false;
  private pending = false;
  private texts: NoteText;
  private shownGran: Granularity | null = null;
  private dayW = 0;
  private syncEdges?: () => void;
  private shiftWeeks = 0;
  private growing = false;

  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin, () => projectsPrefix(plugin.settings)); this.texts = new NoteText(this.app);
    this.root = parentEl.createDiv("samaya-gantt");
    // a resized pane shows a shorter or longer time span; the day width stays (it is only fitted when the scale changes)
    this.ro = new ResizeObserver(() => this.syncEdges?.());
    this.ro.observe(this.root);
  }
  private ro?: ResizeObserver;
  onunload() { this.ro?.disconnect(); window.clearTimeout(this.timer); }
  protected visibleEl(): HTMLElement { return this.root; }
  onDataUpdated(): void {
    if (this.dragging) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 30);
  }

  private render() {
    const s = this.plugin.settings; const gran = s.projectsScale;
    const hidden = s.projectsTableHidden; const nw = hidden ? COLLAPSED_W : Math.max(MIN_NAME_W, s.projectsNameWidth || 200);
    const fit = gran !== this.shownGran || !this.dayW;
    const dayW = fit ? granularityDayWidth(gran, (this.root.querySelector<HTMLElement>(".samaya-gantt-scroll")?.clientWidth ?? this.root.clientWidth) - nw) : this.dayW;
    this.dayW = this.root.clientWidth > 0 ? dayW : 0; // a hidden view has no width to fit to yet
    const changed = gran !== this.shownGran; this.shownGran = this.dayW ? gran : null;
    const every: Project[] = this.data.data.filter(e => e.file.extension === "md").map(e => readProject(this.app, e.file));
    const q = memory.query.trim();
    if (q) this.texts.load(every.map(p => p.file), () => { if (this.root.isConnected && memory.query.trim()) this.onDataUpdated(); });
    const projects = (q ? every.filter(p => matches(p.name.toLowerCase() + " " + p.file.basename.toLowerCase() + " " + this.texts.get(p.file), q)) : every).sort((a, b) => (a.span?.start ?? "9").localeCompare(b.span?.start ?? "9") || a.name.localeCompare(b.name));
    // tasks of each project, by first planned day (undated last); shown under an expanded project
    const tasksOf = new Map<string, Array<{ t: Task; span: { start: string; end: string } | null; period?: boolean }>>();
    for (const t of allTasks(this.app, s)) {
      const pp = projectPathOf(this.app, t.file); if (!pp) continue;
      const dates = t.sessions.length ? t.sessions.map(x => x.date) : t.planned ? [t.planned] : [];
      const exact = taskSpan(dates);
      const span = exact ?? taskPeriod(t.week, t.later, t.horizon || (t.later ? horizonOf(t.later, today()) : ""));
      (tasksOf.get(pp) ?? tasksOf.set(pp, []).get(pp)!).push({ t, span, period: !exact && !!span });
    }
    for (const l of tasksOf.values()) l.sort((a, b) => (a.span?.start ?? "9").localeCompare(b.span?.start ?? "9") || a.t.title.localeCompare(b.t.title));
    const shownRows = projects.reduce((n, p) => {
      const l = tasksOf.get(p.file.path); if (!l || !memory.open.has(p.file.path)) return n + 1;
      const c = collapseTasks(l.length, memory.all.has(p.file.path)); return n + 1 + c.head + c.tail + (c.gap ? 1 : 0);
    }, 0);
    const stats = projectStats(this.app, prefixOf(s.tasksPath), prefixOf(s.ticketsPath));
    const prev = this.root.querySelector<HTMLElement>(".samaya-gantt-scroll");
    const keep = prev && !changed ? { x: prev.scrollLeft + this.shiftWeeks * 7 * dayW, y: prev.scrollTop } : null; this.shiftWeeks = 0; this.growing = false;
    this.root.empty();

    const head = this.root.createDiv("samaya-week-head samaya-day-head samaya-gantt-head");
    renderHeadTitle(head, "Projects", `${projects.length} ${projects.length === 1 ? "project" : "projects"}`);
    const right = head.createDiv("samaya-planner-right");
    const scroll = this.root.createDiv("samaya-gantt-scroll");
    const pillSlot = right.createDiv("samaya-gantt-pill"); // leftmost, so the controls to its right stay put when the Today pill appears
    renderSearch(right, "Search projects", memory.query, v => { memory.query = v; }, () => this.render(), id => { this.timer = id; });
    const sel = right.createEl("select", { cls: "dropdown samaya-gantt-gran", attr: { "aria-label": "Time scale" } });
    for (const g of GRANULARITIES) sel.createEl("option", { text: g[0].toUpperCase() + g.slice(1), value: g });
    sel.value = gran; sel.onchange = () => { s.projectsScale = sel.value as Granularity; void this.plugin.saveSettings(); this.render(); };
    const addProject = () => new TextPromptModal(this.plugin, "New project name", name => {
      safe(createProject(this.app, s, name).then(() => this.plugin.bus.emit()), "creating the project");
    }).open();
    right.createEl("button", { text: "Add project", cls: "mod-cta" }).onclick = addProject;

    const td = today();
    const { from, days } = ganttRange(projects.flatMap(p => [...(p.span ? [p.span] : []), ...(tasksOf.get(p.file.path) ?? []).flatMap(e => (e.span ? [e.span] : []))]), td, memory.back, memory.fwd);
    const width = days * dayW; const todayX = daysBetween(from, td) * dayW + dayW / 2;
    const chart = scroll.createDiv("samaya-gantt-chart"); chart.style.setProperty("--day", `${dayW}px`); chart.style.setProperty("--name", `${nw}px`); chart.style.width = `calc(var(--name) + ${width}px)`; chart.toggleClass("is-collapsed", hidden); chart.style.setProperty("--grid", `${7 * dayW}px`);
    // month: no gridlines, weekends shaded like the sidebars; quarter and year: only a line between months (below)
    chart.style.setProperty("--weekend", gran === "month" ? "linear-gradient(to right, transparent calc(var(--day) * 5), var(--background-secondary) calc(var(--day) * 5))" : "none");

    // a full-height backdrop behind the name column, so the today line and gridlines vanish under it from top to bottom (also in the row borders and below the last row)
    const backdrop = chart.createDiv("samaya-gantt-namebg").createDiv("samaya-gantt-namebg-fill");
    backdrop.createDiv("samaya-gantt-namelines").style.height = `${(projects.length ? shownRows + 1 : 0) * 42}px`; // a line for each row of the chart, no more
    const fitBackdrop = () => { backdrop.style.height = `${chart.offsetHeight}px`; };
    const hdr = chart.createDiv("samaya-gantt-row samaya-gantt-hrow");
    const hName = hdr.createDiv("samaya-gantt-name");
    const toggle = hName.createEl("button", { cls: "clickable-icon samaya-gantt-toggle", attr: { "aria-label": hidden ? "Show table" : "Hide table" } });
    setIcon(toggle, hidden ? "chevrons-right" : "chevrons-left");
    toggle.onclick = () => { s.projectsTableHidden = !hidden; void this.plugin.saveSettings(); this.render(); };
    const hTrack = hdr.createDiv("samaya-gantt-track"); hTrack.style.width = `${width}px`;
    for (const m of monthMarks(from, days)) {
      if (gran !== "month" && m.offset > 0) chart.createDiv("samaya-gantt-mline").style.left = `calc(var(--name) + ${m.offset * dayW}px)`;
      const el = hTrack.createDiv({ cls: "samaya-gantt-month", text: m.span * dayW > 60 ? m.date.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "" });
      el.style.left = `${m.offset * dayW}px`; el.style.width = `${m.span * dayW}px`;
    }
    const step = gran === "month" ? 1 : 7; // month: label every day; otherwise only Mondays
    for (let w = 0; w < days / step; w++) {
      const el = hTrack.createDiv({ cls: "samaya-gantt-week", text: String(parseYmd(addDays(from, w * step)).getDate()) });
      el.style.left = `${w * step * dayW}px`; el.style.width = `${step * dayW}px`;
    }

    if (!projects.length) chart.createDiv({ cls: "samaya-empty", text: q ? "No projects match." : "No projects yet. Use “Add project”." });
    const byProject = new Map<string, Ticket[]>(); // tickets linked to each project (by note path)
    const tickets = allTickets(this.app, s); const allTk = tickets.length > 0;
    for (const t of tickets) { const pp = projectPathOf(this.app, t.file); if (pp) (byProject.get(pp) ?? byProject.set(pp, []).get(pp)!).push(t); }
    const navs: Array<{ track: HTMLElement; bar: HTMLElement; x0: number; x1: number; btn: HTMLElement | null }> = [];
    const ticketByPath = new Map(tickets.map(t => [t.file.path, t] as const));
    const taskRows = (p: Project) => {
      const l = tasksOf.get(p.file.path); if (!l || !memory.open.has(p.file.path)) return;
      const expanded = memory.all.has(p.file.path); const c = collapseTasks(l.length, expanded);
      const one = (e: { t: Task; span: { start: string; end: string } | null; period?: boolean }) => {
        const r = chart.createDiv("samaya-gantt-row samaya-gantt-task"); r.toggleClass("is-done", e.t.status === "done");
        const nm = r.createDiv("samaya-gantt-name");
        nm.addEventListener("contextmenu", ev => showTaskMenu(this.plugin, e.t, ev));
        const cb = nm.createEl("input", { type: "checkbox", cls: "samaya-check", attr: { "aria-label": e.t.status === "done" ? "Mark as not done" : "Mark as done" } });
        cb.checked = e.t.status === "done";
        cb.onclick = ev => { ev.stopPropagation(); safe(setDone(this.app, e.t, cb.checked), "updating the task"); };
        cb.addClass("samaya-gantt-check");
        const lk = nm.createSpan({ cls: "samaya-gantt-link", text: e.t.title });
        lk.onclick = () => { openFileBeside(this.app, e.t.file); };
        const tk = e.t.ticket ? ticketByPath.get(ticketPathOf(this.app, e.t)) : undefined;
        if (tk) nm.createSpan({ cls: `samaya-chip samaya-chip-ticket samaya-gantt-pill-ticket is-${tk.source}`, text: tk.key, attr: { "aria-label": tk.summary || tk.key } }).onclick = ev => { ev.stopPropagation(); openFileSmart(this.app, tk.file); };
        const tr = r.createDiv("samaya-gantt-track"); tr.style.width = `${width}px`;
        if (!e.span) return;
        const b = tr.createDiv({ cls: "samaya-gantt-bar is-task" + (e.t.status === "done" ? " is-done" : "") + (e.period ? " is-period" : "") });
        b.createSpan({ cls: "samaya-gantt-label", text: e.t.title });
        b.style.left = `${daysBetween(from, e.span.start) * dayW}px`; b.style.width = `${(daysBetween(e.span.start, e.span.end) + 1) * dayW}px`;
        const x0 = daysBetween(from, e.span.start) * dayW; navs.push({ track: tr, bar: b, x0, x1: x0 + (daysBetween(e.span.start, e.span.end) + 1) * dayW, btn: null }); // jump arrows and a sticky name, like a project
        b.onclick = () => { openFileBeside(this.app, e.t.file); };
        b.addEventListener("contextmenu", ev => showTaskMenu(this.plugin, e.t, ev));
      };
      const more = (text: string) => {
        const r = chart.createDiv("samaya-gantt-row samaya-gantt-task");
        const btn = r.createDiv("samaya-gantt-name").createEl("button", { cls: "samaya-gantt-more", text });
        btn.onclick = () => { if (expanded) memory.all.delete(p.file.path); else memory.all.add(p.file.path); this.render(); };
        r.createDiv("samaya-gantt-track").style.width = `${width}px`;
      };
      l.slice(0, c.head).forEach(one);
      if (c.gap) more(`Show ${c.gap} more tasks`);
      if (c.tail) l.slice(l.length - c.tail).forEach(one);
      if (expanded && l.length > 6) more("Show fewer");
    };
    for (const p of projects) {
      const row = chart.createDiv("samaya-gantt-row");
      const name = row.createDiv("samaya-gantt-name");
      const myTasks = tasksOf.get(p.file.path) ?? [];
      const isOpen = memory.open.has(p.file.path);
      if (myTasks.length) {
        const arrow = name.createSpan({ cls: "samaya-gantt-arrow", attr: { "aria-label": isOpen ? "Hide tasks" : "Show tasks" } }); setIcon(arrow, isOpen ? "chevron-down" : "chevron-right");
        arrow.onclick = e => { e.stopPropagation(); if (isOpen) memory.open.delete(p.file.path); else memory.open.add(p.file.path); this.render(); };
      } else name.createSpan("samaya-gantt-arrow is-empty");
      const link = name.createSpan({ cls: "samaya-gantt-link", text: p.name }); link.title = p.file.path;
      link.onclick = () => { openFileBeside(this.app, p.file); };
      const linked = byProject.get(p.file.path) ?? [];
      const tp = String(this.app.metadataCache.getFileCache(p.file)?.frontmatter?.ticket_project ?? "");
      const pill = (text: string, source: string, title: string) => name.createSpan({ cls: `samaya-chip samaya-chip-ticket samaya-gantt-pill-ticket is-${source}`, text, attr: { "aria-label": title } });
      if (tp) { // created from a Jira / GitLab project: one pill; clicking lists its linked tickets
        const mine = linked.filter(t => t.project === tp);
        const el = pill(tp, mine[0]?.source ?? "", `Ticket project ${tp}`);
        el.onclick = e => { e.stopPropagation(); if (mine.length === 1) { openFileSmart(this.app, mine[0].file); return; } const m = new Menu(); for (const t of mine) m.addItem(i => i.setTitle(`${t.key} • ${t.summary}`).onClick(() => openFileSmart(this.app, t.file))); m.showAtMouseEvent(e); };
      }
      for (const t of linked) if (!tp || t.project !== tp) pill(t.key, t.source, t.summary || t.key).onclick = e => { e.stopPropagation(); openFileSmart(this.app, t.file); };
      const st = stats.get(p.file.path) ?? { tasks: 0, done: 0, tickets: 0 };
      name.createSpan({ cls: "samaya-gantt-count", text: `${st.done}/${st.tasks}`, attr: { title: `${st.done} of ${st.tasks} tasks done${st.tickets ? `, ${st.tickets} ticket${st.tickets > 1 ? "s" : ""}` : ""}` } });
      row.addEventListener("contextmenu", e => { // the project's actions (they used to be buttons shown on hover)
        e.preventDefault(); const m = new Menu();
        m.addItem(i => i.setTitle("New task").setIcon("circle-check").onClick(() => { this.plugin.newTaskForProject(p.file); }));
        if (s.ticketsOn || byProject.size || allTk) m.addItem(i => i.setTitle("Link to a ticket or ticket project").setIcon("ticket").onClick(() => {
          new TicketTargetSuggestModal(this.plugin, p.file.path, t => {
            void (t.kind === "ticket" ? linkProject(this.app, s, p.file, [t.ticket]) : linkProject(this.app, s, p.file, t.tickets, t.name)).then(() => this.plugin.bus.emit());
          }).open();
        }));
        m.addItem(i => i.setTitle("Plan for…").setIcon("calendar-range").onClick(() => {
          openRangePicker({ x: e.clientX, y: e.clientY, start: p.span?.start, end: p.span?.end }, (start, end) => { safe(patchNote(this.app, p.file, { start, end }), "saving the note"); },
            p.span ? () => { safe(patchNote(this.app, p.file, { start: null, end: null }), "saving the note"); } : undefined);
        }));
        m.addSeparator();
        m.addItem(i => i.setTitle("Open note").setIcon("file").onClick(() => { openFileBeside(this.app, p.file); }));
        m.addItem(i => i.setTitle("Delete project").setIcon("trash").setWarning(true).onClick(() => {
          new ConfirmDeleteModal(this.plugin, p.name, () => { void this.app.fileManager.trashFile(p.file).then(() => { window.setTimeout(() => this.plugin.bus.emit(), 150); }); }, "project").open();
        }));
        m.showAtMouseEvent(e);
      });
      const track = row.createDiv("samaya-gantt-track"); track.style.width = `${width}px`;
      if (!p.span) {
        // not on the timeline yet: hovering shows where a default-length item would go, a click sets its dates
        const hint = track.createDiv({ cls: "samaya-gantt-nodates", text: "Click to place on the timeline" });
        const ghost = track.createDiv("samaya-gantt-bar is-ghost"); ghost.createSpan({ cls: "samaya-gantt-label", text: p.name }); ghost.hide();
        const dayAt = (e: MouseEvent) => Math.floor((e.clientX - track.getBoundingClientRect().left) / dayW);
        track.addClass("is-placeable");
        track.addEventListener("pointermove", e => {
          ghost.style.left = `${dayAt(e) * dayW}px`; ghost.style.width = `${DEFAULT_PROJECT_DAYS * dayW}px`; ghost.show(); hint.hide();
        });
        track.addEventListener("pointerleave", () => { ghost.hide(); hint.show(); });
        track.addEventListener("click", e => {
          if ((e.target as HTMLElement).closest(".samaya-gantt-nav")) return;
          const start = addDays(from, dayAt(e));
          safe(patchNote(this.app, p.file, { start, end: addDays(start, DEFAULT_PROJECT_DAYS - 1) }), "saving the note");
        });
        taskRows(p);
        continue;
      }
      const bar = track.createDiv({ cls: "samaya-gantt-bar" + (p.done ? " is-done" : "") });
      if (st?.tasks) bar.createDiv("samaya-gantt-fill").style.width = `${(st.done / st.tasks) * 100}%`;
      bar.createSpan({ cls: "samaya-gantt-label", text: p.name });
      const place = (sp: { start: string; end: string }) => { bar.style.left = `${daysBetween(from, sp.start) * dayW}px`; bar.style.width = `${(daysBetween(sp.start, sp.end) + 1) * dayW}px`; };
      place(p.span);
      bar.createDiv({ cls: "samaya-gantt-handle is-start" }); bar.createDiv({ cls: "samaya-gantt-handle is-end" });
      this.drag(bar, p, dayW, place);
      const x0 = daysBetween(from, p.span.start) * dayW; navs.push({ track, bar, x0, x1: x0 + (daysBetween(p.span.start, p.span.end) + 1) * dayW, btn: null });
      taskRows(p);
    }
    if (projects.length) {
      const addRow = chart.createDiv("samaya-gantt-row samaya-gantt-addrow");
      const an = addRow.createDiv("samaya-gantt-name");
      const add = an.createEl("input", { type: "text", cls: "samaya-sub-add samaya-gantt-add", attr: { placeholder: "+ New project" } });
      add.addEventListener("keydown", e => {
        if (e.key !== "Enter" || e.isComposing || !add.value.trim()) return;
        const v = add.value.trim(); add.value = ""; safe(createProject(this.app, s, v).then(() => this.plugin.bus.emit()), "creating the project");
      });
      addRow.createDiv("samaya-gantt-track").style.width = `${width}px`;
    }
    if (!hidden) for (const cell of Array.from(chart.querySelectorAll<HTMLElement>(".samaya-gantt-name"))) this.resizer(cell, chart, nw);
    fitBackdrop();
    const line = chart.createDiv("samaya-gantt-today"); line.style.left = `calc(var(--name) + ${todayX}px)`;
    if (keep) { scroll.scrollLeft = keep.x; scroll.scrollTop = keep.y; }
    else if (gran === "year") scroll.scrollLeft = Math.max(0, todayX - 120);
    else { scroll.scrollLeft = Math.max(0, daysBetween(from, `${td.slice(0, 8)}01`) * dayW); }
    // "Today" shows only while the today line is out of sight; the arrow points the way back.
    const sync = () => {
      if (scroll.scrollLeft < 400 && !this.dragging && !this.shiftWeeks) { memory.back += 26; this.shiftWeeks = 26; this.onDataUpdated(); return; } // endless history
      if (scroll.scrollLeft + scroll.clientWidth > scroll.scrollWidth - 400 && !this.dragging && !this.growing) { this.growing = true; memory.fwd += 26; this.onDataUpdated(); return; }
      // A project scrolled out of view (fully or partly) gets an arrow button at the edge it lies beyond; clicking it scrolls back to the project and flashes it.
      const vis = scroll.clientWidth - nw;
      // where a jump scrolls to: the project centred, or its start when it is wider than the view
      const target = (n: { x0: number; x1: number }) => { const w = n.x1 - n.x0; return Math.max(0, w >= vis ? n.x0 - 24 : n.x0 + w / 2 - vis / 2); };
      for (const n of navs) {
        const lo = scroll.scrollLeft, hi = lo + vis;
        // Any project cut off at an edge gets a jump button on that side (the left one when it is cut at both), unless the jump would not move the view.
        const side = n.x0 >= lo && n.x1 <= hi ? null : Math.abs(target(n) - lo) < 2 ? null : n.x0 < lo ? "left" : "right";
        // keep the name in view while the item's left part is scrolled away (right of the jump button when there is one); it may run past the item's right edge
        const label = n.bar.querySelector<HTMLElement>(".samaya-gantt-label");
        if (label) label.style.transform = `translateX(${Math.max(0, lo + (side === "left" ? 34 : 0) - n.x0)}px)`;
        if (!side) { n.btn?.addClass("is-hidden"); continue; }
        if (!n.btn) {
          const btn = n.btn = n.track.createEl("button", { cls: "samaya-gantt-nav" });
          let tip: HTMLElement | null = null;
          // the tooltip (a custom one, to sit beside the button in its row) names the time frame the click scrolls to
          btn.onmouseenter = () => {
            const t = target(n), first = Math.floor(t / dayW), last = Math.max(first, Math.ceil((t + scroll.clientWidth - nw) / dayW) - 1);
            const fmt = (i: number) => parseYmd(addDays(from, i)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
            tip?.remove(); tip = n.track.createDiv({ cls: "samaya-gantt-nav-tip", text: `${fmt(first)} -> ${fmt(last)}` });
            // beside the button, on the side that stays in view (the left edge has the name column on its left)
            if (btn.dataset.side === "left") tip.style.left = `${btn.offsetLeft + 30}px`; else { tip.style.left = `${btn.offsetLeft - 6}px`; tip.style.transform = "translateX(-100%)"; }
          };
          btn.onmouseleave = () => { tip?.remove(); tip = null; };
          btn.onclick = () => {
            tip?.remove(); tip = null;
            scroll.scrollTo({ left: target(n), behavior: "smooth" });
            n.bar.removeClass("is-flash"); void n.bar.offsetWidth; n.bar.addClass("is-flash");
          };
        }
        n.btn.removeClass("is-hidden"); if (n.btn.dataset.side !== side) { n.btn.dataset.side = side; n.btn.empty(); setIcon(n.btn, side === "left" ? "arrow-left" : "arrow-right"); } // (the icon only when the side changes, not on every scroll event)
        n.btn.style.left = `${side === "left" ? scroll.scrollLeft + 6 : scroll.scrollLeft + vis - 30}px`;
      }
      const lo = scroll.scrollLeft, hi = scroll.scrollLeft + scroll.clientWidth - nw;
      const out = todayX < lo ? "left" : todayX > hi ? "right" : null;
      if (out === pillSlot.dataset.out) return; pillSlot.dataset.out = out ?? ""; pillSlot.empty();
      if (out) renderResetPill(pillSlot, "Today", "Scroll back to today", out, () => { scroll.scrollLeft = Math.max(0, todayX - scroll.clientWidth / 3); });
    };
    let frame = 0; scroll.addEventListener("scroll", () => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; sync(); }); }, { passive: true }); // at most once per frame; this.syncEdges = () => { fitBackdrop(); sync(); }; sync();
  }

  /** The drag handle on a name cell's right border: resizes the whole column live, saves on release. */
  private resizer(cell: HTMLElement, chart: HTMLElement, nw: number) {
    const h = cell.createDiv("samaya-gantt-resize"); h.setAttr("aria-label", "Drag to resize");
    h.addEventListener("pointerdown", e => {
      if (e.button !== 0) return; e.preventDefault();
      const x0 = e.clientX; let w = nw; h.setPointerCapture(e.pointerId); this.dragging = true; chart.addClass("is-resizing");
      const onMove = (ev: PointerEvent) => { w = Math.min(MAX_NAME_W, Math.max(MIN_NAME_W, nw + ev.clientX - x0)); chart.style.setProperty("--name", `${w}px`); };
      const onUp = () => {
        h.removeEventListener("pointermove", onMove); h.removeEventListener("pointerup", onUp); h.removeEventListener("pointercancel", onUp);
        this.dragging = false; this.pending = false; chart.removeClass("is-resizing");
        this.plugin.settings.projectsNameWidth = w; void this.plugin.saveSettings(); this.render();
      };
      h.addEventListener("pointermove", onMove); h.addEventListener("pointerup", onUp); h.addEventListener("pointercancel", onUp);
    });
  }

  private drag(bar: HTMLElement, p: Project, dayW: number, place: (s: { start: string; end: string }) => void) {
    bar.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !p.span) return;
      const mode: DragMode = (e.target as HTMLElement).hasClass("is-start") ? "start" : (e.target as HTMLElement).hasClass("is-end") ? "end" : "move";
      const x0 = e.clientX; let delta = 0; let moved = false; const base = p.span;
      bar.setPointerCapture(e.pointerId); this.dragging = true; bar.addClass("is-dragging");
      // resizing names the edge's day in a tooltip beside it (left of the start edge, right of the end edge)
      const tip = mode === "move" ? null : (bar.parentElement as HTMLElement).createDiv("samaya-gantt-nav-tip");
      const showTip = (sp: { start: string; end: string }) => {
        if (!tip) return;
        tip.setText(parseYmd(mode === "start" ? sp.start : sp.end).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }));
        if (mode === "start") { tip.style.left = `${bar.offsetLeft - 6}px`; tip.style.transform = "translateX(-100%)"; } else tip.style.left = `${bar.offsetLeft + bar.offsetWidth + 6}px`;
      };
      showTip(base);
      const onMove = (ev: PointerEvent) => {
        delta = Math.round((ev.clientX - x0) / dayW); if (Math.abs(ev.clientX - x0) > 3) moved = true;
        const sp = dragSpan(base, mode, delta); place(sp); showTip(sp);
      };
      const onUp = () => {
        bar.removeEventListener("pointermove", onMove); bar.removeEventListener("pointerup", onUp); bar.removeEventListener("pointercancel", onUp);
        bar.removeClass("is-dragging"); this.dragging = false; tip?.remove();
        const next = dragSpan(base, mode, delta);
        if (moved && (next.start !== base.start || next.end !== base.end)) safe(patchNote(this.app, p.file, { start: next.start, end: next.end }), "saving the note");
        else if (moved) place(base);
        else if (mode === "move") openFileBeside(this.app, p.file);
        if (this.pending) { this.pending = false; this.onDataUpdated(); }
      };
      bar.addEventListener("pointermove", onMove); bar.addEventListener("pointerup", onUp); bar.addEventListener("pointercancel", onUp);
    });
  }
}
