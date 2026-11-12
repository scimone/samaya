import { TFile, normalizePath } from "obsidian";
import { Panel } from "./panel";
import { openFileSmart } from "../openfile";
import type SamayaPlugin from "../main";
import { Instance, MeetingNote, Series, buildSeries, hueOf, nextWorkday, parseNote, seriesKey } from "../meetingseries";
import { addDays, parseYmd, startOfWeek, today as todayYmd } from "../util";
import { renderDateNav, renderResetPill } from "./dateNav";
import { isoWeek, renderHeadTitle, renderSwitch, weekRangeLabel } from "./plannerHead";

export const MEETINGS_VIEW_TYPE = "samaya-meetings";
type Mode = "series" | "agenda";

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const time = (i: Pick<Instance, "start" | "end">) => i.start == null ? "" : hm(i.start);
const span = (i: Pick<Instance, "start" | "end">) => i.start == null ? "" : `${hm(i.start)}${i.end != null ? "–" + hm(i.end) : ""}`;
const short = (d: string) => parseYmd(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const hue = (i: { title: string }) => hueOf(seriesKey(i.title));
const byTime = (a: Instance, b: Instance) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0);

/** What the view was showing, kept for the session: opening a meeting note replaces the view, and going back must land on the same tab, week and series. */
const memory = { mode: "series" as Mode, week: 0, selected: null as string | null, query: "", onlyNotes: false };

/** A quiet, typographic overview of meeting notes: today and tomorrow, then recurring meetings as a plain list; open one to read its notes. */
export class MeetingsView extends Panel {
  private root: HTMLElement;
  private timer = 0;
  private loading = false; // note bodies still being read: counts and excerpts would be wrong, so they stay hidden
  private inflight = new Set<string>();
  private cache = new Map<string, { mtime: number; body: string }>();

  private tick = 0;
  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin, () => normalizePath(plugin.settings.eventNotesFolder.trim() || "Meetings") + "/"); this.root = parentEl.createDiv("samaya-mt");
    this.tick = window.setInterval(() => { if (this.root.isShown() && !this.root.querySelector("input:focus")) this.rerender(); }, 60000); // a meeting that ends moves from next to recent
  }
  onunload() { window.clearTimeout(this.timer); window.clearInterval(this.tick); }
  onDataUpdated(): void { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { this.render(); }, 30); }

  /** Notes from what Obsidian already has in memory (front matter and any body read before), plus the files whose body still has to be read. Nothing here waits for the disk. */
  private collect(): { notes: MeetingNote[]; missing: TFile[] } {
    const notes: MeetingNote[] = []; const missing: TFile[] = [];
    for (const e of this.data.data) {
      const f = e.file; if (f.extension !== "md") continue;
      const c = this.cache.get(f.path);
      if (!c || c.mtime !== f.stat.mtime) missing.push(f);
      const n = parseNote(f.path, this.app.metadataCache.getFileCache(f)?.frontmatter, f.basename, c?.body ?? ""); if (n) notes.push(n);
    }
    return { notes, missing };
  }
  /** Read bodies in the background, then draw once more with the notes' text. */
  private fill(files: TFile[]) {
    const todo = files.filter(f => !this.inflight.has(f.path)); if (!todo.length) return;
    for (const f of todo) this.inflight.add(f.path);
    void Promise.all(todo.map(async f => {
      try { this.cache.set(f.path, { mtime: f.stat.mtime, body: await this.app.vault.cachedRead(f) }); } catch { this.cache.set(f.path, { mtime: f.stat.mtime, body: "" }); }
      this.inflight.delete(f.path);
    })).then(() => { if (this.root.isConnected) this.render(); });
  }
  private open(path: string, e: MouseEvent) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void openFileSmart(this.app, f, e.ctrlKey || e.metaKey ? "tab" : false);
  }
  private link(parent: HTMLElement, text: string, active: boolean, on: () => void) {
    const a = parent.createSpan({ cls: "samaya-mt-link" + (active ? " is-active" : ""), text }); a.onclick = on; return a;
  }
  private rerender() { this.render(); }

  private render() {
    const { notes, missing } = this.collect();
    this.loading = missing.length > 0;
    const td = todayYmd(); const now = new Date();
    const { series, oneOffs } = buildSeries(notes, td, now.getHours() * 60 + now.getMinutes());
    const y = this.root.querySelector<HTMLElement>(".samaya-mt-page")?.scrollTop ?? 0;
    this.root.empty();
    const sel = memory.selected ? series.find(s => s.key === memory.selected) : undefined;
    if (memory.selected && !sel) memory.selected = null;
    this.head(td, sel);
    const scroller = this.root.createDiv("samaya-mt-page"); const page = scroller.createDiv("samaya-mt-col");
    if (sel) this.detail(page, sel, td); else this.overview(page, series, oneOffs, td, notes.length);
    if (y) scroller.scrollTop = y;
    this.fill(missing);
  }

  /** The top bar, built like the planner's heading: title over a muted line, then (agenda only) week navigation, search and the Overview | Agenda switch on the right: search and switch keep their place in both tabs. */
  private head(td: string, sel?: Series) {
    const head = this.root.createDiv("samaya-week-head samaya-day-head samaya-mt-head");
    const cur = startOfWeek(td); const w = addDays(cur, memory.week * 7);
    if (sel) {
      head.addClass("is-detail");
      renderHeadTitle(head, sel.title, [sel.cadence, sel.days, sel.time].filter(Boolean).join(" · "));
      renderResetPill(head.createDiv("samaya-planner-right"), memory.mode === "agenda" ? "Agenda" : "Overview", "Back to the list of meetings", "left", () => { memory.selected = null; this.rerender(); });
      return;
    }
    if (memory.mode === "agenda") renderHeadTitle(head, `Week ${isoWeek(parseYmd(w))}`, weekRangeLabel(w) + (memory.week === 0 ? " · This week" : ""));
    else renderHeadTitle(head, "Meetings", "\u00a0"); // empty line: the bar keeps the height it has in the agenda
    const right = head.createDiv("samaya-planner-right");
    if (memory.mode === "agenda") {
      if (memory.week !== 0) renderResetPill(right, "This week", "Back to the current week", memory.week < 0 ? "right" : "left", () => { memory.week = 0; this.rerender(); });
      renderDateNav(right, {
        label: weekRangeLabel(w), prevLabel: "Previous week", nextLabel: "Next week",
        onPrev: () => { memory.week--; this.rerender(); }, onNext: () => { memory.week++; this.rerender(); },
        pick: { value: w, label: "Pick a week", run: d => { memory.week = Math.round((parseYmd(startOfWeek(d)).getTime() - parseYmd(cur).getTime()) / (7 * 864e5)); this.rerender(); } }, icon: "calendar",
      });
    }
    const search = right.createEl("input", { cls: "samaya-mt-search", type: "search", placeholder: "Search meetings" }); search.value = memory.query;
    search.oninput = () => {
      memory.query = search.value; window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { this.render(); const el = this.root.querySelector<HTMLInputElement>(".samaya-mt-search"); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, 150);
    };
    renderSwitch<Mode>(right, [["series", "Overview", "Today, recent and recurring meetings"], ["agenda", "Agenda", "One week at a time"]], memory.mode, m => { memory.mode = m; memory.week = 0; this.rerender(); }, "Meetings view");
  }

  // ---- overview
  private overview(page: HTMLElement, series: Series[], oneOffs: Instance[], td: string, total: number) {
    if (!total) { page.createDiv({ cls: "samaya-mt-none", text: "No meeting notes yet." }); return; }

    const all = [...series.flatMap(s => s.instances), ...oneOffs].filter(i => this.matches(i));
    if (memory.mode === "agenda") { this.agenda(page, all, td); return; }

    const tomorrow = nextWorkday(td);
    const next = this.section(page, "Next");
    const upcoming = all.filter(i => i.when !== "past" && i.date <= tomorrow).sort(byTime); // today and the next working day (Monday from Friday on)
    if (!upcoming.length) next.createDiv({ cls: "samaya-mt-none", text: "Nothing planned for the next two days." });
    for (const day of [td, tomorrow]) {
      const items = upcoming.filter(i => i.date === day); if (!items.length) continue;
      const g = next.createDiv("samaya-mt-group");
      g.createDiv({ cls: "samaya-mt-gl", text: day === td ? "Today" : day === addDays(td, 1) ? "Tomorrow" : parseYmd(day).toLocaleDateString(undefined, { weekday: "long" }) });
      this.meetingList(g, items, false);
    }

    const recent = all.filter(i => i.when === "past").sort((x, y) => byTime(y, x)).slice(0, 5);
    if (recent.length) this.meetingList(this.section(page, "Recent"), recent, true);

    const list = series.filter(s => this.matches(s)).sort((a, b) => (a.next ? a.next.date + hm(a.next.start ?? 0) : "9999").localeCompare(b.next ? b.next.date + hm(b.next.start ?? 0) : "9999") || a.title.localeCompare(b.title));
    const col = this.section(page, "Recurring").createDiv("samaya-mt-list");
    if (!list.length) col.createDiv({ cls: "samaya-mt-none", text: "No recurring meetings match." });
    for (const s of list) {
      const r = this.rowEl(col, s); r.style.setProperty("--h", String(s.hue));
      r.createSpan({ cls: "samaya-mt-name", text: s.title });
      r.createSpan({ cls: "samaya-mt-cad", text: [s.cadence, s.days].filter(Boolean).join(" · ") });
      r.createSpan({ cls: "samaya-mt-sub", text: s.next ? (s.next.date === td ? "today" : short(s.next.date)) : "" });
      r.createSpan({ cls: "samaya-mt-count", text: s.held && !this.loading ? `${s.withNotes}/${s.held}` : "", attr: { title: "past meetings with notes" } });
      r.onclick = () => { memory.selected = s.key; memory.onlyNotes = false; this.rerender(); };
    }
  }

  /** A heading with its content in one box: the sticky heading leaves with the last item instead of hanging over empty space. */
  private section(parent: HTMLElement, title: string): HTMLElement {
    const sec = parent.createDiv("samaya-mt-section"); sec.createDiv({ cls: "samaya-mt-h", text: title }); return sec;
  }
  /** meetings as list rows: time (or date when `dated`), title, note marker */
  private meetingList(parent: HTMLElement, items: Instance[], dated: boolean) {
    const col = parent.createDiv("samaya-mt-list");
    for (const i of items) {
      const r = this.rowEl(col, i);
      r.createSpan({ cls: dated ? "samaya-mt-day" : "samaya-mt-time", text: dated ? short(i.date) : time(i) });
      r.createSpan({ cls: "samaya-mt-name", text: i.title.trim() }); this.mark(r, i); r.onclick = e => this.open(i.path, e);
    }
  }
  private matches(i: { title: string }) { const q = memory.query.trim().toLowerCase(); return !q || i.title.toLowerCase().includes(q); }
  private rowEl(parent: HTMLElement, i: { title: string }) { const r = parent.createDiv("samaya-mt-item"); r.style.setProperty("--h", String(hue(i))); r.createSpan("samaya-mt-dot"); return r; }
  /** a small note marker: a dot for notes, the open action count */
  private mark(r: HTMLElement, i: Instance) { if (this.loading) return; if (i.open) r.createSpan({ cls: "samaya-mt-count", text: `${i.open} open` }); else if (i.hasNotes) r.createSpan({ cls: "samaya-mt-count", text: "notes" }); }

  // ---- one series
  private detail(page: HTMLElement, s: Series, td: string) {
    page.style.setProperty("--h", String(s.hue));
    const facts = [`${s.held} held`, this.loading ? "" : `${s.withNotes} with notes`, s.open && !this.loading ? `${s.open} open action${s.open === 1 ? "" : "s"}` : "", s.next ? `next ${s.next.date === td ? "today" : short(s.next.date)}` : ""].filter(Boolean);
    const line = page.createDiv({ cls: "samaya-mt-facts", text: facts.join("  ·  ") });
    this.link(line, memory.onlyNotes ? "show all" : "only with notes", false, () => { memory.onlyNotes = !memory.onlyNotes; this.rerender(); }).addClass("samaya-mt-toggle");

    const items = [...s.instances].reverse().filter(i => !memory.onlyNotes || i.hasNotes);
    if (!items.length) page.createDiv({ cls: "samaya-mt-none", text: "No meetings with notes yet." });
    let last = "";
    let list = page;
    for (const i of items) {
      const g = i.when === "past" ? "Past" : "Upcoming";
      if (g !== last) { list = this.section(page, g).createDiv("samaya-mt-list"); last = g; }
      const r = list.createDiv({ cls: `samaya-mt-entry is-${i.when}` });
      r.createDiv({ cls: "samaya-mt-edate", text: short(i.date) + (i.date === td ? " · today" : "") });
      const body = r.createDiv("samaya-mt-ebody");
      if (i.hasNotes) for (const t of i.excerpt) body.createDiv({ cls: "samaya-mt-eline", text: t });
      else body.createDiv({ cls: "samaya-mt-none", text: this.loading ? "…" : i.when === "past" ? "no notes" : span(i) });
      if (i.open) body.createDiv({ cls: "samaya-mt-count", text: `${i.open} open` });
      r.onclick = e => this.open(i.path, e);
    }
  }

  // ---- agenda: one week at a time
  private agenda(page: HTMLElement, all: Instance[], td: string) {
    const w = addDays(startOfWeek(td), memory.week * 7); const end = addDays(w, 6);
    const items = all.filter(i => i.date >= w && i.date <= end).sort(byTime);
    if (!items.length) page.createDiv({ cls: "samaya-mt-none", text: "No meetings this week." });
    for (let n = 0; n < 7; n++) {
      const d = addDays(w, n); const day = items.filter(i => i.date === d); if (!day.length) continue;
      const g = page.createDiv("samaya-mt-group");
      g.createDiv({ cls: "samaya-mt-gl is-sticky" + (d === td ? " is-today" : ""), text: d === td ? "Today" : d === addDays(td, 1) ? "Tomorrow" : parseYmd(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }) });
      const col = g.createDiv("samaya-mt-list");
      for (const i of day) { const r = this.rowEl(col, i); r.addClass("is-" + i.when); r.createSpan({ cls: "samaya-mt-time", text: time(i) }); r.createSpan({ cls: "samaya-mt-name", text: i.title.trim() }); this.mark(r, i); r.onclick = e => this.open(i.path, e); }
    }
  }
}
