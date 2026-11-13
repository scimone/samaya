import { Panel } from "./panel";
import type SamayaPlugin from "../main";
import { openFileBeside } from "../openfile";
import { DragMode, GRANULARITIES, Granularity, daysBetween, dragSpan, ganttRange, granularityDayWidth, monthMarks } from "../gantt";
import { Project, projectStats, readProject, createProject, projectsPrefix } from "../projects";
import { patchNote, prefixOf } from "../model";
import { TextPromptModal } from "../modals";
import { renderHeadTitle } from "./plannerHead";
import { renderResetPill } from "./dateNav";
import { NoteText, matches, renderSearch } from "./search";

const memory: { query: string; gran: Granularity } = { query: "", gran: "quarter" };
import { addDays, parseYmd, today } from "../util";

export const GANTT_VIEW_TYPE = "samaya-gantt";

export class GanttView extends Panel {
  private root: HTMLElement;
  private timer = 0;
  private dragging = false;
  private pending = false;
  private texts: NoteText;
  private shownGran: Granularity | null = null;
  private lastW = 0;

  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin, () => projectsPrefix(plugin.settings)); this.texts = new NoteText(this.app);
    this.root = parentEl.createDiv("samaya-gantt");
    this.ro = new ResizeObserver(() => {
      const w = this.root.querySelector<HTMLElement>(".samaya-gantt-scroll")?.clientWidth ?? 0;
      if (memory.gran !== "year" && w && Math.abs(w - this.lastW) > 40) this.onDataUpdated();
    });
    this.ro.observe(this.root);
  }
  private ro?: ResizeObserver;
  onunload() { this.ro?.disconnect(); window.clearTimeout(this.timer); }
  onDataUpdated(): void {
    if (this.dragging) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 30);
  }

  private render() {
    const s = this.plugin.settings; const gran = memory.gran;
    const dayW = granularityDayWidth(gran, (this.root.querySelector<HTMLElement>(".samaya-gantt-scroll")?.clientWidth ?? this.root.clientWidth) - 200);
    const changed = gran !== this.shownGran; this.shownGran = gran;
    const every: Project[] = this.data.data.filter(e => e.file.extension === "md").map(e => readProject(this.app, e.file));
    const q = memory.query.trim();
    if (q) this.texts.load(every.map(p => p.file), () => { if (this.root.isConnected && memory.query.trim()) this.onDataUpdated(); });
    const projects = (q ? every.filter(p => matches(p.name.toLowerCase() + " " + p.file.basename.toLowerCase() + " " + this.texts.get(p.file), q)) : every).sort((a, b) => (a.span?.start ?? "9").localeCompare(b.span?.start ?? "9") || a.name.localeCompare(b.name));
    const stats = projectStats(this.app, prefixOf(s.tasksPath), prefixOf(s.ticketsPath));
    const prev = this.root.querySelector<HTMLElement>(".samaya-gantt-scroll");
    const keep = prev && !changed ? { x: prev.scrollLeft, y: prev.scrollTop } : null;
    this.root.empty();

    const head = this.root.createDiv("samaya-week-head samaya-day-head samaya-gantt-head");
    renderHeadTitle(head, "Projects", `${projects.length} ${projects.length === 1 ? "project" : "projects"}`);
    const right = head.createDiv("samaya-planner-right");
    const scroll = this.root.createDiv("samaya-gantt-scroll");
    renderSearch(right, "Search projects", memory.query, v => { memory.query = v; }, () => this.render(), id => { this.timer = id; });
    const sel = right.createEl("select", { cls: "dropdown samaya-gantt-gran", attr: { "aria-label": "Time scale" } });
    for (const g of GRANULARITIES) sel.createEl("option", { text: g[0].toUpperCase() + g.slice(1), value: g });
    sel.value = gran; sel.onchange = () => { memory.gran = sel.value as Granularity; this.render(); };
    const pillSlot = right.createDiv("samaya-gantt-pill");
    right.createEl("button", { text: "Add project", cls: "mod-cta" }).onclick = () => new TextPromptModal(this.plugin, "New project name", name => {
      void createProject(this.app, s, name).then(() => this.plugin.bus.emit());
    }).open();

    const td = today();
    const { from, days } = ganttRange(projects.flatMap(p => (p.span ? [p.span] : [])), td);
    const width = days * dayW; const todayX = daysBetween(from, td) * dayW + dayW / 2;
    const chart = scroll.createDiv("samaya-gantt-chart"); chart.style.setProperty("--day", `${dayW}px`); chart.style.width = `${200 + width}px`; chart.style.setProperty("--grid", `${(gran === "month" ? 1 : 7) * dayW}px`);

    const hdr = chart.createDiv("samaya-gantt-row samaya-gantt-hrow");
    hdr.createDiv("samaya-gantt-name");
    const hTrack = hdr.createDiv("samaya-gantt-track"); hTrack.style.width = `${width}px`;
    for (const m of monthMarks(from, days)) {
      const el = hTrack.createDiv({ cls: "samaya-gantt-month", text: m.span * dayW > 60 ? m.date.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "" });
      el.style.left = `${m.offset * dayW}px`; el.style.width = `${m.span * dayW}px`;
    }
    const step = gran === "month" ? 1 : 7; // month: label every day; otherwise only Mondays
    for (let w = 0; w < days / step; w++) {
      const el = hTrack.createDiv({ cls: "samaya-gantt-week", text: String(parseYmd(addDays(from, w * step)).getDate()) });
      el.style.left = `${w * step * dayW}px`; el.style.width = `${step * dayW}px`;
    }

    if (!projects.length) chart.createDiv({ cls: "samaya-empty", text: q ? "No projects match." : "No projects yet. Use “Add project”." });
    for (const p of projects) {
      const row = chart.createDiv("samaya-gantt-row");
      const name = row.createDiv("samaya-gantt-name");
      const link = name.createSpan({ cls: "samaya-gantt-link", text: p.name }); link.title = p.file.path;
      link.onclick = () => { openFileBeside(this.app, p.file); };
      const st = stats.get(p.file.path);
      if (st) name.createSpan({ cls: "samaya-gantt-count", text: `${st.done}/${st.tasks}`, attr: { title: `${st.done} of ${st.tasks} tasks done${st.tickets ? `, ${st.tickets} ticket${st.tickets > 1 ? "s" : ""}` : ""}` } });
      const track = row.createDiv("samaya-gantt-track"); track.style.width = `${width}px`;
      if (!p.span) { track.createDiv({ cls: "samaya-gantt-nodates", text: "Set start and end in the note" }); continue; }
      const bar = track.createDiv({ cls: "samaya-gantt-bar" + (p.done ? " is-done" : "") });
      if (st?.tasks) bar.createDiv("samaya-gantt-fill").style.width = `${(st.done / st.tasks) * 100}%`;
      bar.createSpan({ cls: "samaya-gantt-label", text: p.name });
      const place = (sp: { start: string; end: string }) => { bar.style.left = `${daysBetween(from, sp.start) * dayW}px`; bar.style.width = `${(daysBetween(sp.start, sp.end) + 1) * dayW}px`; };
      place(p.span);
      bar.createDiv({ cls: "samaya-gantt-handle is-start" }); bar.createDiv({ cls: "samaya-gantt-handle is-end" });
      this.drag(bar, p, dayW, place);
    }
    const line = chart.createDiv("samaya-gantt-today"); line.style.left = `${200 + todayX}px`;
    if (keep) { scroll.scrollLeft = keep.x; scroll.scrollTop = keep.y; }
    else if (gran === "year") scroll.scrollLeft = Math.max(0, todayX - 120);
    else { scroll.scrollLeft = Math.max(0, daysBetween(from, `${td.slice(0, 8)}01`) * dayW); }
    this.lastW = scroll.clientWidth;
    // "Today" shows only while the today line is out of sight; the arrow points the way back.
    const sync = () => {
      const lo = scroll.scrollLeft, hi = scroll.scrollLeft + scroll.clientWidth - 200;
      const out = todayX < lo ? "left" : todayX > hi ? "right" : null;
      if (out === pillSlot.dataset.out) return; pillSlot.dataset.out = out ?? ""; pillSlot.empty();
      if (out) renderResetPill(pillSlot, "Today", "Scroll back to today", out, () => { scroll.scrollLeft = Math.max(0, todayX - scroll.clientWidth / 3); });
    };
    scroll.addEventListener("scroll", sync, { passive: true }); sync();
  }

  private drag(bar: HTMLElement, p: Project, dayW: number, place: (s: { start: string; end: string }) => void) {
    bar.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !p.span) return;
      const mode: DragMode = (e.target as HTMLElement).hasClass("is-start") ? "start" : (e.target as HTMLElement).hasClass("is-end") ? "end" : "move";
      const x0 = e.clientX; let delta = 0; let moved = false; const base = p.span;
      bar.setPointerCapture(e.pointerId); this.dragging = true; bar.addClass("is-dragging");
      const onMove = (ev: PointerEvent) => {
        delta = Math.round((ev.clientX - x0) / dayW); if (Math.abs(ev.clientX - x0) > 3) moved = true;
        place(dragSpan(base, mode, delta));
      };
      const onUp = () => {
        bar.removeEventListener("pointermove", onMove); bar.removeEventListener("pointerup", onUp); bar.removeEventListener("pointercancel", onUp);
        bar.removeClass("is-dragging"); this.dragging = false;
        const next = dragSpan(base, mode, delta);
        if (moved && (next.start !== base.start || next.end !== base.end)) void patchNote(this.app, p.file, { start: next.start, end: next.end });
        else if (moved) place(base);
        else if (mode === "move") openFileBeside(this.app, p.file);
        if (this.pending) { this.pending = false; this.onDataUpdated(); }
      };
      bar.addEventListener("pointermove", onMove); bar.addEventListener("pointerup", onUp); bar.addEventListener("pointercancel", onUp);
    });
  }
}
