import { BasesView, QueryController, TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { Instance, MeetingNote, Series, buildSeries, hueOf, parseNote, seriesKey, untilLabel } from "../meetingseries";
import { addDays, parseYmd, startOfWeek, today as todayYmd } from "../util";

export const MEETINGS_VIEW_TYPE = "samaya-meetings";
type Mode = "series" | "agenda";
type Sort = "next" | "count" | "name";

const dayLabel = (d: string) => parseYmd(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const time = (i: Pick<Instance, "start" | "end">) => i.start == null ? "" : `${hm(i.start)}${i.end != null ? "–" + hm(i.end) : ""}`;
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Meeting notes as a living overview: recurring meetings become series cards with a pulse strip of every instance; open one to read its notes as a timeline. */
export class MeetingsView extends BasesView {
  readonly type = MEETINGS_VIEW_TYPE;
  private root: HTMLElement;
  private timer = 0;
  private token = 0;
  private mode: Mode = "series";
  private sort: Sort = "next";
  private selected: string | null = null;
  private query = "";
  private onlyNotes = false;
  private cache = new Map<string, { mtime: number; body: string }>();
  private scrolled = false;

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) { super(controller); this.root = parentEl.createDiv("samaya-mt"); }
  onunload() { window.clearTimeout(this.timer); }
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

  private async render() {
    const token = ++this.token;
    const notes = await this.readNotes();
    if (token !== this.token) return;
    const td = todayYmd(); const now = new Date(); const nowMin = now.getHours() * 60 + now.getMinutes();
    const { series, oneOffs } = buildSeries(notes, td);
    const keep = this.root.querySelector<HTMLElement>(".samaya-mt-body"); const y = keep?.scrollTop ?? 0;
    this.root.empty();

    const sel = this.selected ? series.find(s => s.key === this.selected) : undefined;
    if (this.selected && !sel) this.selected = null;
    if (sel) { this.detail(sel, td); return; }

    this.head(series, oneOffs, notes.length);
    const body = this.root.createDiv("samaya-mt-body");
    if (!notes.length) { body.createDiv({ cls: "samaya-empty", text: "No meeting notes yet. Notes in the Meetings folder with a date, start and end show up here." }); return; }
    this.upNext(body, [...series.flatMap(s => s.instances), ...oneOffs], td, nowMin);
    if (this.mode === "series") this.seriesGrid(body, series, oneOffs, td); else this.agenda(body, [...series.flatMap(s => s.instances), ...oneOffs], td);
    if (y) body.scrollTop = y;
  }

  // ---- header
  private head(series: Series[], oneOffs: Instance[], total: number) {
    const head = this.root.createDiv("samaya-mt-head");
    const title = head.createDiv("samaya-mt-title");
    title.createEl("h2", { text: "Meetings" });
    const held = series.reduce((n, s) => n + s.held, 0) + oneOffs.filter(o => o.when === "past").length;
    const withNotes = series.reduce((n, s) => n + s.withNotes, 0) + oneOffs.filter(o => o.when === "past" && o.hasNotes).length;
    title.createSpan({ cls: "samaya-mt-sub", text: `${plural(series.length, "series")} · ${plural(total, "meeting")} · ${held ? Math.round((withNotes / held) * 100) : 0}% of past meetings have notes` });
    const tools = head.createDiv("samaya-mt-tools");
    const seg = tools.createDiv("samaya-mt-seg");
    for (const [m, label, icon] of [["series", "Series", "layers"], ["agenda", "Agenda", "calendar-days"]] as Array<[Mode, string, string]>) {
      const b = seg.createEl("button", { cls: this.mode === m ? "is-active" : "" }); setIcon(b.createSpan(), icon); b.createSpan({ text: label });
      b.onclick = () => { this.mode = m; this.scrolled = false; void this.render(); };
    }
    const search = tools.createEl("input", { cls: "samaya-mt-search", type: "search", placeholder: "Filter meetings…" }); search.value = this.query;
    search.oninput = () => { this.query = search.value; window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render().then(() => this.root.querySelector<HTMLInputElement>(".samaya-mt-search")?.focus()); }, 150); };
    if (this.mode === "series") {
      const sort = tools.createEl("select", { cls: "dropdown" });
      for (const [v, l] of [["next", "Next up first"], ["count", "Most meetings"], ["name", "A–Z"]] as Array<[Sort, string]>) sort.createEl("option", { value: v, text: l });
      sort.value = this.sort; sort.onchange = () => { this.sort = sort.value as Sort; void this.render(); };
    }
  }

  private matches(i: { title: string }) { const q = this.query.trim().toLowerCase(); return !q || i.title.toLowerCase().includes(q); }

  // ---- up next
  private upNext(body: HTMLElement, all: Instance[], td: string, nowMin: number) {
    const next = all.filter(i => this.matches(i) && (i.when === "upcoming" || (i.when === "today" && (i.end ?? i.start ?? 0) > nowMin)))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0)).slice(0, 6);
    if (!next.length) return;
    const wrap = body.createDiv("samaya-mt-next");
    wrap.createDiv({ cls: "samaya-mt-label", text: "Up next" });
    const row = wrap.createDiv("samaya-mt-next-row");
    for (const i of next) {
      const c = row.createDiv({ cls: "samaya-mt-nextcard" + (i.date === td ? " is-today" : "") }); c.style.setProperty("--h", String(this.hue(i)));
      c.createDiv({ cls: "samaya-mt-when", text: untilLabel(i.date, i.start, td, nowMin, dayLabel) });
      c.createDiv({ cls: "samaya-mt-nexttitle", text: i.title });
      c.createDiv({ cls: "samaya-mt-nexttime", text: time(i) });
      c.onclick = e => this.open(i.path, e);
    }
  }
  private hue(i: { title: string }) { return hueOf(seriesKey(i.title)); }

  // ---- series overview
  private seriesGrid(body: HTMLElement, all: Series[], oneOffs: Instance[], td: string) {
    const list = all.filter(s => this.matches(s));
    const far = "9999";
    list.sort(this.sort === "count" ? (a, b) => b.instances.length - a.instances.length || a.title.localeCompare(b.title)
      : this.sort === "name" ? (a, b) => a.title.localeCompare(b.title)
      : (a, b) => (a.next ? a.next.date + hm(a.next.start ?? 0) : far).localeCompare(b.next ? b.next.date + hm(b.next.start ?? 0) : far) || a.title.localeCompare(b.title));
    body.createDiv({ cls: "samaya-mt-label", text: "Recurring meetings" });
    const grid = body.createDiv("samaya-mt-grid");
    if (!list.length) grid.createDiv({ cls: "samaya-empty", text: "No recurring meetings match." });
    for (const s of list) {
      const card = grid.createDiv("samaya-mt-card"); card.style.setProperty("--h", String(s.hue));
      const top = card.createDiv("samaya-mt-cardtop");
      top.createDiv({ cls: "samaya-mt-cardtitle", text: s.title });
      if (s.open) top.createSpan({ cls: "samaya-mt-open", text: String(s.open), attr: { title: `${plural(s.open, "open action item")}` } });
      const meta = card.createDiv("samaya-mt-meta");
      const ic = meta.createSpan("samaya-mt-ic"); setIcon(ic, "repeat");
      meta.createSpan({ text: [s.cadence, s.days, s.time].filter(Boolean).join(" · ") });
      this.pulse(card.createDiv("samaya-mt-pulse"), s, 26);
      const cov = s.held ? s.withNotes / s.held : 0;
      const foot = card.createDiv("samaya-mt-foot");
      const bar = foot.createDiv("samaya-mt-cov"); bar.createDiv("samaya-mt-covfill").style.width = `${cov * 100}%`;
      foot.createSpan({ cls: "samaya-mt-covtxt", text: s.held ? `${s.withNotes}/${s.held} with notes` : "No past meetings" });
      const n = card.createDiv("samaya-mt-nextline");
      if (s.next) { n.createSpan({ cls: "samaya-mt-dim", text: s.next.when === "today" ? "Today" : "Next" }); n.createSpan({ text: s.next.when === "today" ? time(s.next) : dayLabel(s.next.date) }); }
      else n.createSpan({ cls: "samaya-mt-dim", text: s.last ? `Last ${dayLabel(s.last.date)}` : "" });
      card.onclick = () => { this.selected = s.key; this.onlyNotes = false; void this.render(); };
    }
    const singles = oneOffs.filter(o => this.matches(o));
    if (singles.length) {
      body.createDiv({ cls: "samaya-mt-label", text: "One-off meetings" });
      const col = body.createDiv("samaya-mt-oneoffs");
      for (const o of singles) this.row(col, o, td, true);
    }
  }

  /** One cell per meeting of the series: filled = notes taken, outlined = held without notes, ring = today, dashed = still to come. */
  private pulse(el: HTMLElement, s: Series, max: number) {
    const idx = s.instances.findIndex(i => i.when !== "past"); const at = idx < 0 ? s.instances.length : idx;
    const from = Math.max(0, Math.min(s.instances.length - max, at - Math.floor(max * 0.7)));
    const shown = s.instances.slice(from, from + max);
    if (from > 0) el.createSpan({ cls: "samaya-mt-more", text: `+${from}` });
    for (const i of shown) {
      const c = el.createSpan({ cls: `samaya-mt-cell is-${i.when}${i.hasNotes ? " has-notes" : ""}` });
      c.title = `${dayLabel(i.date)} ${time(i)}\n${i.hasNotes ? i.excerpt[0] : i.when === "upcoming" ? "Upcoming" : "No notes"}`;
      c.onclick = e => { e.stopPropagation(); this.open(i.path, e); };
    }
    const after = s.instances.length - from - shown.length; if (after > 0) el.createSpan({ cls: "samaya-mt-more", text: `+${after}` });
  }

  // ---- series detail
  private detail(s: Series, td: string) {
    const root = this.root.createDiv("samaya-mt-detail"); root.style.setProperty("--h", String(s.hue));
    const bar = root.createDiv("samaya-mt-dhead");
    const back = bar.createEl("button", { cls: "samaya-mt-back" }); setIcon(back.createSpan(), "arrow-left"); back.createSpan({ text: "All series" });
    back.onclick = () => { this.selected = null; void this.render(); };
    const ttl = root.createDiv("samaya-mt-dtitle");
    ttl.createEl("h2", { text: s.title });
    const meta = ttl.createDiv("samaya-mt-meta"); setIcon(meta.createSpan("samaya-mt-ic"), "repeat");
    meta.createSpan({ text: [s.cadence, s.days, s.time].filter(Boolean).join(" · ") });

    const stats = root.createDiv("samaya-mt-stats");
    const tile = (v: string, l: string) => { const t = stats.createDiv("samaya-mt-stat"); t.createDiv({ cls: "samaya-mt-statv", text: v }); t.createDiv({ cls: "samaya-mt-statl", text: l }); };
    tile(String(s.held), "held");
    tile(s.held ? `${Math.round((s.withNotes / s.held) * 100)}%` : "–", "with notes");
    tile(String(s.open), "open actions");
    tile(s.next ? (s.next.when === "today" ? "Today" : dayLabel(s.next.date)) : "–", "next");

    const strip = root.createDiv("samaya-mt-bigpulse"); this.pulse(strip, s, 60);
    const legend = root.createDiv("samaya-mt-legend");
    for (const [c, l] of [["is-past has-notes", "notes taken"], ["is-past", "no notes"], ["is-today", "today"], ["is-upcoming", "upcoming"]]) { legend.createSpan({ cls: `samaya-mt-cell ${c}` }); legend.createSpan({ text: l }); }
    const only = legend.createEl("label", { cls: "samaya-mt-only" }); const cb = only.createEl("input", { type: "checkbox" }); cb.checked = this.onlyNotes; only.createSpan({ text: "Only meetings with notes" });
    cb.onchange = () => { this.onlyNotes = cb.checked; void this.render(); };

    const tl = root.createDiv("samaya-mt-timeline");
    const items = [...s.instances].reverse().filter(i => !this.onlyNotes || i.hasNotes);
    let lastWhen = "";
    for (const i of items) {
      const group = i.when === "past" ? "Past" : "Upcoming";
      if (group !== lastWhen) { tl.createDiv({ cls: "samaya-mt-label", text: group }); lastWhen = group; }
      this.row(tl, i, td, false);
    }
    if (!items.length) tl.createDiv({ cls: "samaya-empty", text: "No meetings with notes yet." });
  }

  /** A meeting in a list: date block, time, and what the note says (or an invitation to take notes). */
  private row(parent: HTMLElement, i: Instance, td: string, withTitle: boolean) {
    const r = parent.createDiv({ cls: `samaya-mt-row is-${i.when}${i.hasNotes ? " has-notes" : ""}` }); r.style.setProperty("--h", String(this.hue(i)));
    const d = parseYmd(i.date);
    const date = r.createDiv("samaya-mt-date");
    date.createDiv({ cls: "samaya-mt-dnum", text: String(d.getDate()) });
    date.createDiv({ cls: "samaya-mt-dmon", text: d.toLocaleDateString(undefined, { month: "short" }) });
    const main = r.createDiv("samaya-mt-rmain");
    const line = main.createDiv("samaya-mt-rline");
    if (withTitle) line.createSpan({ cls: "samaya-mt-rtitle", text: i.title });
    line.createSpan({ cls: "samaya-mt-rwhen", text: `${d.toLocaleDateString(undefined, { weekday: "long" })}${time(i) ? " · " + time(i) : ""}${i.date === td ? " · today" : ""}` });
    if (i.open) line.createSpan({ cls: "samaya-mt-open", text: `${i.open} open`, attr: { title: "Unchecked action items in the note" } });
    if (i.hasNotes) { const ex = main.createDiv("samaya-mt-excerpt"); for (const t of i.excerpt) ex.createDiv({ text: t }); }
    else main.createDiv({ cls: "samaya-mt-none", text: i.when === "upcoming" ? "Not held yet" : i.when === "today" ? "Open the note to take notes" : "No notes taken" });
    r.onclick = e => this.open(i.path, e);
  }

  // ---- agenda
  private agenda(body: HTMLElement, all: Instance[], td: string) {
    const list = all.filter(i => this.matches(i)).sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0));
    const weeks = new Map<string, Map<string, Instance[]>>();
    for (const i of list) { const w = startOfWeek(i.date); const days = weeks.get(w) ?? new Map(); const l = days.get(i.date) ?? []; l.push(i); days.set(i.date, l); weeks.set(w, days); }
    const thisWeek = startOfWeek(td);
    body.createDiv({ cls: "samaya-mt-label", text: "Agenda" });
    const wrap = body.createDiv("samaya-mt-agenda");
    for (const [w, days] of weeks) {
      const sec = wrap.createDiv({ cls: "samaya-mt-week" + (w === thisWeek ? " is-current" : "") });
      const end = addDays(w, 6);
      sec.createDiv({ cls: "samaya-mt-weekhead", text: `${w === thisWeek ? "This week · " : ""}${parseYmd(w).toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${parseYmd(end).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` });
      for (const [d, items] of days) {
        const day = sec.createDiv({ cls: "samaya-mt-day" + (d === td ? " is-today" : "") });
        day.createDiv({ cls: "samaya-mt-dayname", text: dayLabel(d) });
        const col = day.createDiv("samaya-mt-daylist");
        for (const i of items) {
          const c = col.createDiv({ cls: `samaya-mt-chip is-${i.when}${i.hasNotes ? " has-notes" : ""}` }); c.style.setProperty("--h", String(this.hue(i)));
          c.createSpan({ cls: "samaya-mt-chiptime", text: time(i) });
          c.createSpan({ cls: "samaya-mt-chiptitle", text: i.title.trim() });
          if (i.recurring !== false) setIcon(c.createSpan({ cls: "samaya-mt-chipic", attr: { title: "Recurring" } }), "repeat");
          if (i.hasNotes) setIcon(c.createSpan({ cls: "samaya-mt-chipic is-notes", attr: { title: i.excerpt[0] } }), "file-text");
          c.onclick = e => this.open(i.path, e);
        }
      }
    }
    if (!this.scrolled) { this.scrolled = true; window.setTimeout(() => body.querySelector(".samaya-mt-week.is-current")?.scrollIntoView({ block: "start" }), 0); }
  }
}
