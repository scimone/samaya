import { BasesView, QueryController, TFile } from "obsidian";
import type SamayaPlugin from "../main";
import { Instance, MeetingNote, Series, buildSeries, hueOf, parseNote, seriesKey } from "../meetingseries";
import { addDays, parseYmd, startOfWeek, today as todayYmd } from "../util";

export const MEETINGS_VIEW_TYPE = "samaya-meetings";
type Mode = "series" | "agenda";

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const time = (i: Pick<Instance, "start" | "end">) => i.start == null ? "" : hm(i.start);
const span = (i: Pick<Instance, "start" | "end">) => i.start == null ? "" : `${hm(i.start)}${i.end != null ? "–" + hm(i.end) : ""}`;
const short = (d: string) => parseYmd(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const hue = (i: { title: string }) => hueOf(seriesKey(i.title));
const byTime = (a: Instance, b: Instance) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0);

/** A quiet, typographic overview of meeting notes: today and tomorrow, then recurring meetings as a plain list; open one to read its notes. */
export class MeetingsView extends BasesView {
  readonly type = MEETINGS_VIEW_TYPE;
  private root: HTMLElement;
  private timer = 0;
  private token = 0;
  private mode: Mode = "series";
  private selected: string | null = null;
  private query = "";
  private onlyNotes = false;
  private cache = new Map<string, { mtime: number; body: string }>();

  private week = 0; // agenda: weeks from the current one
  private tick = 0;
  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller); this.root = parentEl.createDiv("samaya-mt");
    this.tick = window.setInterval(() => { if (this.root.isShown() && !this.root.querySelector("input:focus")) this.rerender(); }, 60000); // a meeting that ends moves from next to recent
  }
  onunload() { window.clearTimeout(this.timer); window.clearInterval(this.tick); }
  onDataUpdated(): void { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render(); }, 30); }

  private async readNotes(): Promise<MeetingNote[]> {
    const files = this.data.data.map(e => e.file).filter(f => f.extension === "md");
    const notes = await Promise.all(files.map(async f => {
      let c = this.cache.get(f.path);
      if (!c || c.mtime !== f.stat.mtime) { c = { mtime: f.stat.mtime, body: await this.app.vault.cachedRead(f) }; this.cache.set(f.path, c); }
      return parseNote(f.path, this.app.metadataCache.getFileCache(f)?.frontmatter, f.basename, c.body);
    }));
    return notes.filter((n): n is MeetingNote => !!n);
  }
  private open(path: string, e: MouseEvent) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void this.app.workspace.getLeaf(e.ctrlKey || e.metaKey ? "tab" : false).openFile(f);
  }
  private link(parent: HTMLElement, text: string, active: boolean, on: () => void) {
    const a = parent.createSpan({ cls: "samaya-mt-link" + (active ? " is-active" : ""), text }); a.onclick = on; return a;
  }
  private rerender() { void this.render(); }

  private async render() {
    const token = ++this.token;
    const notes = await this.readNotes();
    if (token !== this.token) return;
    const td = todayYmd(); const now = new Date();
    const { series, oneOffs } = buildSeries(notes, td, now.getHours() * 60 + now.getMinutes());
    const y = this.root.querySelector<HTMLElement>(".samaya-mt-page")?.scrollTop ?? 0;
    this.root.empty();
    const scroller = this.root.createDiv("samaya-mt-page"); const page = scroller.createDiv("samaya-mt-col");
    const sel = this.selected ? series.find(s => s.key === this.selected) : undefined;
    if (this.selected && !sel) this.selected = null;
    if (sel) this.detail(page, sel, td); else this.overview(page, series, oneOffs, td, notes.length);
    if (y) scroller.scrollTop = y;
  }

  // ---- overview
  private overview(page: HTMLElement, series: Series[], oneOffs: Instance[], td: string, total: number) {
    const head = page.createDiv("samaya-mt-head");
    head.createEl("h2", { text: "Meetings" });
    const nav = head.createDiv("samaya-mt-nav");
    this.link(nav, "Overview", this.mode === "series", () => { this.mode = "series"; this.rerender(); });
    this.link(nav, "Agenda", this.mode === "agenda", () => { this.mode = "agenda"; this.week = 0; this.rerender(); });
    const search = nav.createEl("input", { cls: "samaya-mt-search", type: "search", placeholder: "Search" }); search.value = this.query;
    search.oninput = () => { this.query = search.value; window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render().then(() => { const el = this.root.querySelector<HTMLInputElement>(".samaya-mt-search"); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }); }, 150); };
    if (!total) { page.createDiv({ cls: "samaya-mt-none", text: "No meeting notes yet." }); return; }

    const all = [...series.flatMap(s => s.instances), ...oneOffs].filter(i => this.matches(i));
    if (this.mode === "agenda") { this.agenda(page, all, td); return; }

    const tomorrow = addDays(td, 1);
    page.createDiv({ cls: "samaya-mt-h", text: "Next" });
    const upcoming = all.filter(i => i.when !== "past" && i.date <= tomorrow).sort(byTime);
    if (!upcoming.length) page.createDiv({ cls: "samaya-mt-none", text: "Nothing planned today or tomorrow." });
    for (const day of [td, tomorrow]) {
      const items = upcoming.filter(i => i.date === day); if (!items.length) continue;
      const g = page.createDiv("samaya-mt-group");
      g.createDiv({ cls: "samaya-mt-gl", text: day === td ? "Today" : "Tomorrow" });
      this.meetingList(g, items, false);
    }

    const recent = all.filter(i => i.when === "past").sort((x, y) => byTime(y, x)).slice(0, 5);
    if (recent.length) { page.createDiv({ cls: "samaya-mt-h", text: "Recent" }); this.meetingList(page, recent, true); }

    const list = series.filter(s => this.matches(s)).sort((a, b) => (a.next ? a.next.date + hm(a.next.start ?? 0) : "9999").localeCompare(b.next ? b.next.date + hm(b.next.start ?? 0) : "9999") || a.title.localeCompare(b.title));
    page.createDiv({ cls: "samaya-mt-h", text: "Recurring" });
    const col = page.createDiv("samaya-mt-list");
    if (!list.length) col.createDiv({ cls: "samaya-mt-none", text: "No recurring meetings match." });
    for (const s of list) {
      const r = this.rowEl(col, s); r.style.setProperty("--h", String(s.hue));
      r.createSpan({ cls: "samaya-mt-name", text: s.title });
      r.createSpan({ cls: "samaya-mt-cad", text: [s.cadence, s.days].filter(Boolean).join(" · ") });
      r.createSpan({ cls: "samaya-mt-sub", text: s.next ? (s.next.date === td ? "today" : short(s.next.date)) : "" });
      r.createSpan({ cls: "samaya-mt-count", text: s.held ? `${s.withNotes}/${s.held}` : "", attr: { title: "past meetings with notes" } });
      r.onclick = () => { this.selected = s.key; this.onlyNotes = false; this.rerender(); };
    }
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
  private matches(i: { title: string }) { const q = this.query.trim().toLowerCase(); return !q || i.title.toLowerCase().includes(q); }
  private rowEl(parent: HTMLElement, i: { title: string }) { const r = parent.createDiv("samaya-mt-item"); r.style.setProperty("--h", String(hue(i))); r.createSpan("samaya-mt-dot"); return r; }
  /** a small note marker: a dot for notes, the open action count */
  private mark(r: HTMLElement, i: Instance) { if (i.open) r.createSpan({ cls: "samaya-mt-count", text: `${i.open} open` }); else if (i.hasNotes) r.createSpan({ cls: "samaya-mt-count", text: "notes" }); }

  // ---- one series
  private detail(page: HTMLElement, s: Series, td: string) {
    page.style.setProperty("--h", String(s.hue));
    const back = page.createDiv({ cls: "samaya-mt-link samaya-mt-back", text: "← Meetings" }); back.onclick = () => { this.selected = null; this.rerender(); };
    page.createEl("h2", { cls: "samaya-mt-dtitle", text: s.title });
    page.createDiv({ cls: "samaya-mt-sub", text: [s.cadence, s.days, s.time].filter(Boolean).join(" · ") });
    const facts = [`${s.held} held`, `${s.withNotes} with notes`, s.open ? `${s.open} open action${s.open === 1 ? "" : "s"}` : "", s.next ? `next ${s.next.date === td ? "today" : short(s.next.date)}` : ""].filter(Boolean);
    const line = page.createDiv({ cls: "samaya-mt-facts", text: facts.join("  ·  ") });
    this.link(line, this.onlyNotes ? "show all" : "only with notes", false, () => { this.onlyNotes = !this.onlyNotes; this.rerender(); }).addClass("samaya-mt-toggle");

    const items = [...s.instances].reverse().filter(i => !this.onlyNotes || i.hasNotes);
    if (!items.length) page.createDiv({ cls: "samaya-mt-none", text: "No meetings with notes yet." });
    let last = "";
    let list = page.createDiv("samaya-mt-list");
    for (const i of items) {
      const g = i.when === "past" ? "Past" : "Upcoming";
      if (g !== last) { page.createDiv({ cls: "samaya-mt-h", text: g }); list = page.createDiv("samaya-mt-list"); last = g; }
      const r = list.createDiv({ cls: `samaya-mt-entry is-${i.when}` });
      r.createDiv({ cls: "samaya-mt-edate", text: short(i.date) + (i.date === td ? " · today" : "") });
      const body = r.createDiv("samaya-mt-ebody");
      if (i.hasNotes) for (const t of i.excerpt) body.createDiv({ cls: "samaya-mt-eline", text: t });
      else body.createDiv({ cls: "samaya-mt-none", text: i.when === "past" ? "no notes" : span(i) });
      if (i.open) body.createDiv({ cls: "samaya-mt-count", text: `${i.open} open` });
      r.onclick = e => this.open(i.path, e);
    }
  }

  // ---- agenda: one week at a time
  private agenda(page: HTMLElement, all: Instance[], td: string) {
    const cur = startOfWeek(td); const w = addDays(cur, this.week * 7); const end = addDays(w, 6);
    const fmt = (d: string) => parseYmd(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const bar = page.createDiv("samaya-mt-weeknav");
    const prev = bar.createSpan({ cls: "samaya-mt-arrow", text: "‹", attr: { title: "Previous week" } }); prev.onclick = () => { this.week--; this.rerender(); };
    const label = bar.createSpan({ cls: "samaya-mt-weeklabel", text: `${this.week === 0 ? "This week" : this.week === 1 ? "Next week" : this.week === -1 ? "Last week" : "Week of " + fmt(w)}  ·  ${fmt(w)} – ${fmt(end)}` });
    const next = bar.createSpan({ cls: "samaya-mt-arrow", text: "›", attr: { title: "Next week" } }); next.onclick = () => { this.week++; this.rerender(); };
    if (this.week !== 0) { label.title = "Back to this week"; label.onclick = () => { this.week = 0; this.rerender(); }; }

    const items = all.filter(i => i.date >= w && i.date <= end).sort(byTime);
    if (!items.length) page.createDiv({ cls: "samaya-mt-none", text: "No meetings this week." });
    for (let n = 0; n < 7; n++) {
      const d = addDays(w, n); const day = items.filter(i => i.date === d); if (!day.length) continue;
      const g = page.createDiv("samaya-mt-group");
      g.createDiv({ cls: "samaya-mt-gl" + (d === td ? " is-today" : ""), text: d === td ? "Today" : d === addDays(td, 1) ? "Tomorrow" : parseYmd(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }) });
      const col = g.createDiv("samaya-mt-list");
      for (const i of day) { const r = this.rowEl(col, i); r.addClass("is-" + i.when); r.createSpan({ cls: "samaya-mt-time", text: time(i) }); r.createSpan({ cls: "samaya-mt-name", text: i.title.trim() }); this.mark(r, i); r.onclick = e => this.open(i.path, e); }
    }
  }
}
