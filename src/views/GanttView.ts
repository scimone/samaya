import { Panel } from "./panel";
import type SamayaPlugin from "../main";
import { openFileSmart } from "../openfile";
import { DragMode, daysBetween, dragSpan, ganttRange, monthMarks } from "../gantt";
import { Project, projectStats, readProject, createProject, projectsPrefix } from "../projects";
import { patchNote, prefixOf } from "../model";
import { TextPromptModal } from "../modals";
import { renderHeadTitle } from "./plannerHead";
import { addDays, parseYmd, today } from "../util";

export const GANTT_VIEW_TYPE = "samaya-gantt";

export class GanttView extends Panel {
  private root: HTMLElement;
  private timer = 0;
  private dragging = false;
  private pending = false;

  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin, () => projectsPrefix(plugin.settings));
    this.root = parentEl.createDiv("samaya-gantt");
  }
  onunload() { window.clearTimeout(this.timer); }
  onDataUpdated(): void {
    if (this.dragging) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 30);
  }

  private render() {
    const s = this.plugin.settings; const dayW = Number(this.config.get("dayWidth")) || 22;
    const projects: Project[] = this.data.data.filter(e => e.file.extension === "md").map(e => readProject(this.app, e.file)).sort((a, b) => (a.span?.start ?? "9").localeCompare(b.span?.start ?? "9") || a.name.localeCompare(b.name));
    const stats = projectStats(this.app, prefixOf(s.tasksPath), prefixOf(s.ticketsPath));
    const prev = this.root.querySelector<HTMLElement>(".samaya-gantt-scroll");
    const keep = prev ? { x: prev.scrollLeft, y: prev.scrollTop } : null;
    this.root.empty();

    const head = this.root.createDiv("samaya-week-head samaya-day-head samaya-gantt-head");
    renderHeadTitle(head, "Projects", `${projects.length} ${projects.length === 1 ? "project" : "projects"}`);
    const right = head.createDiv("samaya-planner-right");
    const scroll = this.root.createDiv("samaya-gantt-scroll");
    right.createEl("button", { text: "Today" }).onclick = () => { scroll.scrollLeft = Math.max(0, todayX - scroll.clientWidth / 3); };
    right.createEl("button", { text: "Add project", cls: "mod-cta" }).onclick = () => new TextPromptModal(this.plugin, "New project name", name => {
      void createProject(this.app, s, name).then(() => this.plugin.bus.emit());
    }).open();

    const td = today();
    const { from, days } = ganttRange(projects.flatMap(p => (p.span ? [p.span] : [])), td);
    const width = days * dayW; const todayX = daysBetween(from, td) * dayW + dayW / 2;
    const chart = scroll.createDiv("samaya-gantt-chart"); chart.style.setProperty("--day", `${dayW}px`); chart.style.width = `${200 + width}px`;

    const hdr = chart.createDiv("samaya-gantt-row samaya-gantt-hrow");
    hdr.createDiv("samaya-gantt-name");
    const hTrack = hdr.createDiv("samaya-gantt-track"); hTrack.style.width = `${width}px`;
    for (const m of monthMarks(from, days)) {
      const el = hTrack.createDiv({ cls: "samaya-gantt-month", text: m.span * dayW > 60 ? m.date.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "" });
      el.style.left = `${m.offset * dayW}px`; el.style.width = `${m.span * dayW}px`;
    }
    for (let w = 0; w < days / 7; w++) {
      const el = hTrack.createDiv({ cls: "samaya-gantt-week", text: String(parseYmd(addDays(from, w * 7)).getDate()) });
      el.style.left = `${w * 7 * dayW}px`; el.style.width = `${7 * dayW}px`;
    }

    if (!projects.length) chart.createDiv({ cls: "samaya-empty", text: "No projects yet. Use “Add project”." });
    for (const p of projects) {
      const row = chart.createDiv("samaya-gantt-row");
      const name = row.createDiv("samaya-gantt-name");
      const link = name.createSpan({ cls: "samaya-gantt-link", text: p.name }); link.title = p.file.path;
      link.onclick = e => { void openFileSmart(this.app, p.file, e.ctrlKey || e.metaKey ? "tab" : false); };
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
    if (keep) { scroll.scrollLeft = keep.x; scroll.scrollTop = keep.y; } else scroll.scrollLeft = Math.max(0, todayX - 120);
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
        if (this.pending) { this.pending = false; this.onDataUpdated(); }
      };
      bar.addEventListener("pointermove", onMove); bar.addEventListener("pointerup", onUp); bar.addEventListener("pointercancel", onUp);
    });
  }
}
