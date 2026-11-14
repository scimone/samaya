import { TFile, normalizePath } from "obsidian";
import { Panel } from "./panel";
import { openFileSmart } from "../openfile";
import type SamayaPlugin from "../main";
import { Instance, MeetingNote, Series, buildSeries, hueOf, nextWorkday, parseNote, seriesKey } from "../meetingseries";
import { addDays, parseYmd, startOfWeek, today as todayYmd } from "../util";
import { weekValue, weekValueDate } from "../journaldigest";
import { renderDateNav, renderResetPill } from "./dateNav";
import { renderSearch } from "./search";
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

/**
 * Meeting notes as a dashboard that fits the pane, built like the journal and the tasks page: a row of figures, then sections that each scroll on their own
 * (next, recent, recurring); the agenda is one column per day; open a recurring meeting to read its notes. The page itself never scrolls (a narrow pane stacks the sections and does).
 */
export class MeetingsView extends Panel {
  private root: HTMLElement;
  private timer = 0;
  private loading = false; // note bodies still being read: counts and excerpts would be wrong, so they stay hidden
  private inflight = new Set<string>();
  private cache = new Map<string, { mtime: number; body: string }>();

  private tick = 0;
  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin, () => normalizePath(plugin.settings.eventNotesFolder.trim() || "Meetings") + "/"); this.root = parentEl.createDiv("samaya-mt samaya-md");
    this.tick = window.setInterval(() => { if (this.root.isShown() && !this.root.querySelector("input:focus")) this.rerender(); }, 60000); // a meeting that ends moves from next to recent
  }
  onunload() { window.clearTimeout(this.timer); window.clearInterval(this.tick); }
  protected visibleEl(): HTMLElement { return this.root; }
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
  private rerender() { this.render(); }

  private render() {
    const { notes, missing } = this.collect();
    this.loading = missing.length > 0;
    const td = todayYmd(); const now = new Date();
    const { series, oneOffs } = buildSeries(notes, td, now.getHours() * 60 + now.getMinutes());
    const keep = Array.from(this.root.querySelectorAll<HTMLElement>("[data-keep]")).map(el => [el.dataset.keep!, el.scrollTop, el.scrollLeft] as const); // every scroller keeps its place across a redraw
    this.root.empty();
    const sel = memory.selected ? series.find(s => s.key === memory.selected) : undefined;
    if (memory.selected && !sel) memory.selected = null;
    this.head(td, sel);
    const page = this.root.createDiv("samaya-md-page");
    if (sel) this.detail(page, sel, td); else this.overview(page, series, oneOffs, td, notes.length);
    for (const [k, top, left] of keep) { const el = this.root.querySelector<HTMLElement>(`[data-keep="${k}"]`); if (el) { el.scrollTop = top; el.scrollLeft = left; } }
    this.fill(missing);
  }

  /** A scroller that remembers its position across redraws. */
  private scroller(parent: HTMLElement, key: string, cls: string): HTMLElement {
    const el = parent.createDiv(cls); el.dataset.keep = key; return el;
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
    else renderHeadTitle(head, "Meetings", " "); // empty line: the bar keeps the height it has in the agenda
    const right = head.createDiv("samaya-planner-right");
    if (memory.mode === "agenda") {
      if (memory.week !== 0) renderResetPill(right, "This week", "Back to the current week", memory.week < 0 ? "right" : "left", () => { memory.week = 0; this.rerender(); });
      renderDateNav(right, {
        label: weekRangeLabel(w), prevLabel: "Previous week", nextLabel: "Next week",
        onPrev: () => { memory.week--; this.rerender(); }, onNext: () => { memory.week++; this.rerender(); },
        pick: { value: weekValue(w), type: "week", label: "Pick a week", run: v => { memory.week = Math.round((parseYmd(weekValueDate(v)).getTime() - parseYmd(cur).getTime()) / (7 * 864e5)); this.rerender(); } }, icon: "calendar",
      });
    }
    renderSearch(right, "Search meetings", memory.query, v => { memory.query = v; }, () => this.render(), id => { this.timer = id; });
    renderSwitch<Mode>(right, [["series", "Overview", "Today, recent and recurring meetings"], ["agenda", "Agenda", "One week at a time"]], memory.mode, m => { memory.mode = m; memory.week = 0; this.rerender(); }, "Meetings view");
  }

  // ---- shared pieces
  /** A section: the quiet small-caps heading (with an optional count and action on its right) over a box that scrolls on its own. */
  private section(parent: HTMLElement, title: string, key: string, count?: number | string): { sec: HTMLElement; body: HTMLElement; head: HTMLElement } {
    const sec = parent.createDiv("samaya-md-sec"); const head = sec.createDiv("samaya-md-sec-head");
    head.createDiv({ cls: "samaya-mt-h", text: title });
    if (count != null && count !== "") head.createSpan({ cls: "samaya-md-sec-count", text: String(count) });
    return { sec, head, body: this.scroller(sec, key, "samaya-md-scroll") };
  }
  private none(parent: HTMLElement, text: string) { parent.createDiv({ cls: "samaya-md-none", text }); }
  /** the query matches a meeting's title or the text of its note (a series: any of its meetings) */
  private matches(i: { title: string; body?: string; instances?: Instance[] }): boolean {
    const q = memory.query.trim().toLowerCase(); if (!q) return true;
    if (i.title.toLowerCase().includes(q) || (i.body ?? "").toLowerCase().includes(q)) return true;
    return !!i.instances?.some(n => n.body.toLowerCase().includes(q));
  }
  /** a meeting happening right now: today, started, not yet over */
  private isLive(i: Pick<Instance, "date" | "start" | "end">): boolean {
    if (i.date !== todayYmd() || i.start == null) return false;
    const now = new Date(); const m = now.getHours() * 60 + now.getMinutes();
    return i.start <= m && m < (i.end ?? i.start + 60);
  }
  private rowEl(parent: HTMLElement, i: { title: string }) {
    const r = parent.createDiv("samaya-md-row"); r.style.setProperty("--h", String(hue(i))); r.createSpan("samaya-md-dot");
    if ("date" in i && this.isLive(i as Instance)) r.addClass("is-live");
    return r;
  }
  /** a small note marker: the open action count, or "notes" */
  private mark(r: HTMLElement, i: Instance) { if (this.loading) return; if (i.open) r.createSpan({ cls: "samaya-md-badge is-open", text: `${i.open} open` }); else if (i.hasNotes) r.createSpan({ cls: "samaya-md-badge", text: "notes" }); }
  /** a meeting as a row: time (or date when `dated`), title, note marker */
  private meetingRow(parent: HTMLElement, i: Instance, dated = false) {
    const r = this.rowEl(parent, i); r.addClass("is-" + i.when);
    r.createSpan({ cls: dated ? "samaya-md-when is-date" : "samaya-md-when", text: dated ? short(i.date) : time(i) });
    r.createSpan({ cls: "samaya-md-name", text: i.title.trim() }); this.mark(r, i); r.onclick = e => this.open(i.path, e);
    return r;
  }
  private dayLabel(d: string, td: string, long = true): string {
    return d === td ? "Today" : d === addDays(td, 1) ? "Tomorrow" : parseYmd(d).toLocaleDateString(undefined, { weekday: long ? "long" : "short" });
  }

  // ---- overview: figures on top, then three sections that fill the rest
  private overview(page: HTMLElement, series: Series[], oneOffs: Instance[], td: string, total: number) {
    if (!total) { this.none(page, "No meeting notes yet."); return; }

    const everything = [...series.flatMap(s => s.instances), ...oneOffs];
    const all = everything.filter(i => this.matches(i));
    if (memory.query.trim()) { this.results(page, all, td); return; }
    if (memory.mode === "agenda") { this.agenda(page, all, td); return; }

    this.figures(page, everything, td);
    const body = page.createDiv("samaya-md-body"); const left = body.createDiv("samaya-md-col"); const right = body.createDiv("samaya-md-col");

    const tomorrow = nextWorkday(td);
    const upcoming = all.filter(i => i.when !== "past" && i.date <= tomorrow).sort(byTime); // today and the next working day (Monday from Friday on)
    const next = this.section(left, "Next", "next", upcoming.length || "");
    if (!upcoming.length) this.none(next.body, "Nothing planned for the next two days.");
    for (const day of [td, tomorrow]) {
      const items = upcoming.filter(i => i.date === day); if (!items.length) continue;
      const g = next.body.createDiv("samaya-md-group");
      g.createDiv({ cls: "samaya-md-gl" + (day === td ? " is-today" : ""), text: this.dayLabel(day, td) });
      for (const i of items) this.meetingRow(g, i);
    }

    const recent = all.filter(i => i.when === "past").sort((x, y) => byTime(y, x)).slice(0, 12);
    const rec = this.section(left, "Recent", "recent");
    if (!recent.length) this.none(rec.body, "No past meetings yet.");
    for (const i of recent) this.meetingRow(rec.body, i, true);

    const list = series.filter(s => this.matches(s)).sort((a, b) => (a.next ? a.next.date + hm(a.next.start ?? 0) : "9999").localeCompare(b.next ? b.next.date + hm(b.next.start ?? 0) : "9999") || a.title.localeCompare(b.title));
    const rc = this.section(right, "Recurring", "recurring", list.length || "");
    if (!list.length) this.none(rc.body, "No recurring meetings match.");
    for (const s of list) {
      const r = this.rowEl(rc.body, s); r.style.setProperty("--h", String(s.hue));
      const text = r.createDiv("samaya-md-stack");
      text.createSpan({ cls: "samaya-md-name", text: s.title });
      text.createSpan({ cls: "samaya-md-sub", text: [s.cadence, s.days].filter(Boolean).join(" · ") });
      const meta = r.createDiv("samaya-md-meta");
      meta.createSpan({ cls: "samaya-md-next", text: s.next ? (s.next.date === td ? "today" : short(s.next.date)) : "" });
      if (s.held && !this.loading) meta.createSpan({ cls: "samaya-md-sub", text: `${s.withNotes}/${s.held} noted`, attr: { "aria-label": "past meetings with notes" } });
      r.onclick = () => { memory.selected = s.key; memory.onlyNotes = false; this.rerender(); };
    }
  }

  /** The row of figures on top (the jump cards of the journal): what is left today, this week, open actions and how many meetings have notes. */
  private figures(page: HTMLElement, all: Instance[], td: string) {
    const row = page.createDiv("samaya-md-cards");
    const card = (kicker: string, value: string, sub: string, tone: "" | "meet" | "warn" = "", fill?: number) => {
      const c = row.createDiv("samaya-md-card" + (tone ? " is-" + tone : ""));
      c.createDiv({ cls: "samaya-md-card-kicker", text: kicker });
      c.createDiv({ cls: "samaya-md-card-value", text: value });
      c.createDiv({ cls: "samaya-md-card-sub", text: sub || " " });
      if (fill != null) c.createDiv("samaya-md-card-bar").createDiv("samaya-md-card-fill").style.width = `${Math.round(fill * 100)}%`;
    };
    const today = all.filter(i => i.date === td); const left = today.filter(i => i.when !== "past").sort(byTime);
    const live = left.find(i => this.isLive(i)); const nxt = left.find(i => !this.isLive(i) && i.start != null);
    card("Today", String(left.length), !today.length ? "no meetings" : live ? `now: ${live.title.trim()}` : nxt ? `next at ${time(nxt)}` : `of ${today.length} done`, "meet", today.length ? (today.length - left.length) / today.length : undefined);
    const w = startOfWeek(td); const wk = all.filter(i => i.date >= w && i.date <= addDays(w, 6));
    card("This week", String(wk.length), `Week ${isoWeek(parseYmd(w))}`, "meet", wk.length ? wk.filter(i => i.when === "past").length / wk.length : undefined);
    const past = all.filter(i => i.when === "past"); const noted = past.filter(i => i.hasNotes).length; const open = all.reduce((s, i) => s + i.open, 0);
    card("Open actions", this.loading ? "…" : String(open), this.loading ? "" : open ? `in ${all.filter(i => i.open).length} meeting${all.filter(i => i.open).length === 1 ? "" : "s"}` : "all clear", open && !this.loading ? "warn" : "");
    card("With notes", this.loading || !past.length ? "…" : `${Math.round(noted / past.length * 100)}%`, this.loading || !past.length ? "" : `${noted} of ${past.length} past meetings`, "", this.loading || !past.length ? undefined : noted / past.length);
  }

  // ---- one series
  private detail(page: HTMLElement, s: Series, td: string) {
    page.style.setProperty("--h", String(s.hue)); page.addClass("is-detail");
    const row = page.createDiv("samaya-md-cards");
    const card = (kicker: string, value: string, sub: string, tone: "" | "meet" | "warn" = "") => {
      const c = row.createDiv("samaya-md-card" + (tone ? " is-" + tone : "")); c.createDiv({ cls: "samaya-md-card-kicker", text: kicker }); c.createDiv({ cls: "samaya-md-card-value", text: value }); c.createDiv({ cls: "samaya-md-card-sub", text: sub || " " });
    };
    card("Held", String(s.held), s.last ? `last ${short(s.last.date)}` : "", "meet");
    card("With notes", this.loading ? "…" : String(s.withNotes), this.loading || !s.held ? "" : `${Math.round(s.withNotes / s.held * 100)}% of held`);
    card("Open actions", this.loading ? "…" : String(s.open), s.open && !this.loading ? "to follow up" : this.loading ? "" : "all clear", s.open && !this.loading ? "warn" : "");
    card("Next", s.next ? (s.next.date === td ? "Today" : short(s.next.date)) : "—", s.next ? span(s.next) : "none planned", "meet");

    const items = [...s.instances].reverse().filter(i => !memory.onlyNotes || i.hasNotes);
    const body = page.createDiv("samaya-md-body is-detail");
    const entries = (box: HTMLElement, list: Instance[]) => {
      for (const i of list) {
        const r = box.createDiv({ cls: `samaya-md-entry is-${i.when}` });
        r.createDiv({ cls: "samaya-md-edate", text: short(i.date) + (i.date === td ? " · today" : "") });
        const eb = r.createDiv("samaya-md-ebody");
        if (i.hasNotes) for (const t of i.excerpt) eb.createDiv({ cls: "samaya-md-eline", text: t });
        else eb.createDiv({ cls: "samaya-md-eline is-faint", text: this.loading ? "…" : i.when === "past" ? "no notes" : span(i) });
        if (i.open) eb.createSpan({ cls: "samaya-md-badge is-open", text: `${i.open} open` });
        r.onclick = e => this.open(i.path, e);
      }
    };
    const up = items.filter(i => i.when !== "past").reverse(); const past = items.filter(i => i.when === "past");
    if (up.length) { const u = this.section(body.createDiv("samaya-md-col"), "Upcoming", "d-up", up.length); entries(u.body, up); }
    const p = this.section(body.createDiv("samaya-md-col"), "Past", "d-past", past.length || "");
    const toggle = p.head.createEl("button", { cls: "samaya-md-toggle" + (memory.onlyNotes ? " is-on" : ""), text: "Only with notes", attr: { "aria-pressed": String(memory.onlyNotes) } });
    toggle.onclick = () => { memory.onlyNotes = !memory.onlyNotes; this.rerender(); };
    if (!past.length) this.none(p.body, memory.onlyNotes ? "No meetings with notes yet." : "Nothing held yet."); else entries(p.body, past);
  }

  // ---- search results: every meeting that matches, newest first, under its date (both tabs)
  private results(page: HTMLElement, all: Instance[], td: string) {
    const dates = [...new Set(all.map(i => i.date))].sort((a, b) => b.localeCompare(a));
    const { body } = this.section(page.createDiv("samaya-md-col is-results"), `${all.length} ${all.length === 1 ? "meeting" : "meetings"}`, "results");
    if (!all.length) { this.none(body, "No meetings match."); return; }
    for (const d of dates) {
      const g = body.createDiv("samaya-md-group");
      g.createDiv({ cls: "samaya-md-gl is-sticky" + (d === td ? " is-today" : ""), text: d === td ? "Today" : d === addDays(td, 1) ? "Tomorrow" : parseYmd(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" }) });
      for (const i of all.filter(x => x.date === d).sort(byTime)) this.meetingRow(g, i);
    }
  }

  // ---- agenda: one week, a column per day (like the board of the tasks page); each column scrolls on its own
  private agenda(page: HTMLElement, all: Instance[], td: string) {
    const w = addDays(startOfWeek(td), memory.week * 7);
    const items = all.filter(i => i.date >= w && i.date <= addDays(w, 6)).sort(byTime);
    const days = [0, 1, 2, 3, 4, 5, 6].map(n => addDays(w, n)).filter((d, n) => n < 5 || items.some(i => i.date === d)); // the weekend only when something is planned
    const scroll = this.scroller(page, "agenda", "samaya-md-week-scroll");
    const grid = scroll.createDiv("samaya-md-week"); grid.style.setProperty("--cols", String(days.length));
    for (const d of days) {
      const day = items.filter(i => i.date === d);
      const col = grid.createDiv("samaya-md-day" + (d === td ? " is-today" : ""));
      const head = col.createDiv("samaya-md-day-head");
      head.createSpan({ cls: "samaya-md-day-label", text: parseYmd(d).toLocaleDateString(undefined, { weekday: "short" }) });
      head.createSpan({ cls: "samaya-md-day-num", text: String(parseYmd(d).getDate()) });
      if (day.length) head.createSpan({ cls: "samaya-md-sec-count", text: String(day.length) });
      const cell = this.scroller(col, "day-" + d, "samaya-md-cell");
      if (!day.length) cell.createDiv({ cls: "samaya-md-empty", text: "Free" });
      for (const i of day) {
        const c = cell.createDiv("samaya-md-tile is-" + i.when); c.style.setProperty("--h", String(hue(i)));
        if (this.isLive(i)) c.addClass("is-live");
        const top = c.createDiv("samaya-md-tile-top"); top.createSpan({ cls: "samaya-md-when", text: span(i) }); this.mark(top, i);
        c.createDiv({ cls: "samaya-md-tile-title", text: i.title.trim() });
        c.onclick = e => this.open(i.path, e);
      }
    }
  }
}
