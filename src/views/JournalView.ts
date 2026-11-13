import { TFile } from "obsidian";
import { Panel } from "./panel";
import { openFileSmart } from "../openfile";
import type SamayaPlugin from "../main";
import { PERIODIC_KINDS, PERIOD_UI, Period, fmtEstimate, listPeriodNotes, openPeriodNote, periodNotePath } from "../journal";
import { anchor, digest, groupLabel, rowLabel, sameSpan } from "../journaldigest";
import { parseYmd, today as todayYmd } from "../util";
import { isoWeek, renderHeadTitle, renderSwitch, weekRangeLabel } from "./plannerHead";

interface Note { file: TFile; date: string }
interface Now { p: Period; path: string; file: TFile | null }

const NAMES: Record<Period, { tab: string; hint: string; adj: string }> = {
  daily: { tab: "Days", hint: "Daily notes", adj: "daily" }, weekly: { tab: "Weeks", hint: "Weekly notes", adj: "weekly" },
  monthly: { tab: "Months", hint: "Monthly notes", adj: "monthly" }, quarterly: { tab: "Quarters", hint: "Quarterly notes", adj: "quarterly" },
  yearly: { tab: "Years", hint: "Yearly notes", adj: "yearly" },
};
const PAGE = 60;

/** What the view was showing, kept for the session: opening a note replaces nothing, but coming back should land on the same period. */
const memory = { period: "daily" as Period, query: "", shown: PAGE };

/** The journal at a glance: the current day, week, month, quarter and year (the kinds switched on in the settings), then the notes of one kind, newest first, each with a line or two of what it says. A click opens the note in a tab. */
export class JournalView extends Panel {
  private root: HTMLElement;
  private timer = 0; private seq = 0;
  private lists = new Map<Period, Note[]>(); private now: Now[] = [];
  private loading = false; // note bodies still being read: previews would be wrong, so they stay hidden
  private inflight = new Set<string>();
  private cache = new Map<string, { mtime: number; body: string }>();

  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) { super(plugin); this.root = parentEl.createDiv("samaya-mt samaya-jn"); }
  onload() {
    super.onload();
    this.register(this.plugin.bus.on(() => this.onDataUpdated())); // the settings decide which kinds of notes exist
    const tick = window.setInterval(() => { if (this.root.isShown() && !this.root.querySelector("input:focus")) this.onDataUpdated(); }, 5 * 60000); // midnight: "Today" moves on
    this.register(() => window.clearInterval(tick));
  }
  onunload() { window.clearTimeout(this.timer); this.seq++; }
  onDataUpdated(): void { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.reload(); }, 250); }

  private periods(): Period[] { const s = this.plugin.settings; return s.journalOn ? ["daily", ...PERIODIC_KINDS.filter(k => s.journalNotes[k].on)] : []; }

  /** Find the notes (names only, nothing is read yet), then draw. */
  private async reload() {
    const seq = ++this.seq; const s = this.plugin.settings; const ps = this.periods(); const lists = new Map<Period, Note[]>(); const now: Now[] = [];
    for (const p of ps) {
      lists.set(p, (await listPeriodNotes(this.app, s, p)).reverse());
      const n = await periodNotePath(this.app, s, p, todayYmd()); if (n) now.push({ p, ...n });
    }
    if (seq !== this.seq) return; // a newer load is under way
    this.lists = lists; this.now = now; this.render();
  }

  private body(f: TFile | null): string | null { const c = f && this.cache.get(f.path); return c && f && c.mtime === f.stat.mtime ? c.body : null; }
  /** Read the notes' text in the background, then draw once more with it. */
  private fill(files: TFile[]) {
    const todo = files.filter(f => this.body(f) === null && !this.inflight.has(f.path)); if (!todo.length) return;
    for (const f of todo) this.inflight.add(f.path);
    void Promise.all(todo.map(async f => {
      try { this.cache.set(f.path, { mtime: f.stat.mtime, body: await this.app.vault.cachedRead(f) }); } catch { this.cache.set(f.path, { mtime: f.stat.mtime, body: "" }); }
      this.inflight.delete(f.path);
    })).then(() => { if (this.root.isConnected && !this.inflight.size) this.render(); });
  }

  /** Open in a tab; a note that is already open in one is brought to the front instead. A missing note is created first. */
  private async open(file: TFile | null, p: Period, date: string) {
    const f = file ?? await openPeriodNote(this.app, this.plugin.settings, p, date);
    if (f) openFileSmart(this.app, f, "tab");
  }
  private row(parent: HTMLElement, cls: string, run: () => void): HTMLElement {
    const r = parent.createDiv({ cls: `samaya-mt-entry ${cls}`, attr: { role: "link", tabindex: "0" } });
    r.onclick = run; r.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); run(); } });
    return r;
  }
  private section(parent: HTMLElement, title: string): HTMLElement {
    const sec = parent.createDiv("samaya-mt-section"); if (title) sec.createDiv({ cls: "samaya-mt-h", text: title }); return sec;
  }

  private render() {
    const y = this.root.querySelector<HTMLElement>(".samaya-mt-page")?.scrollTop ?? 0;
    this.root.empty();
    const ps = this.periods(); if (!ps.includes(memory.period)) memory.period = "daily";
    this.head(ps);
    const page = this.root.createDiv("samaya-mt-page").createDiv("samaya-mt-col");
    if (!ps.length) { page.createDiv({ cls: "samaya-mt-none", text: "The journal is switched off. Turn it on in the settings." }); return; }
    const q = memory.query.trim().toLowerCase(); const need: TFile[] = [];

    if (!q) { this.nowSection(page, need); }
    this.listSection(page, ps, q, need);
    this.loading = need.some(f => this.body(f) === null);
    if (y) this.root.querySelector<HTMLElement>(".samaya-mt-page")!.scrollTop = y;
    this.fill(need);
  }

  private head(ps: Period[]) {
    const head = this.root.createDiv("samaya-week-head samaya-day-head samaya-mt-head");
    const n = this.lists.get(memory.period)?.length ?? 0;
    renderHeadTitle(head, "Journal", ps.length ? `${n} ${NAMES[memory.period].adj} note${n === 1 ? "" : "s"}` : " ");
    if (!ps.length) return;
    const right = head.createDiv("samaya-planner-right");
    const search = right.createEl("input", { cls: "samaya-mt-search", type: "search", placeholder: "Search notes" }); search.value = memory.query;
    search.oninput = () => {
      memory.query = search.value; memory.shown = PAGE; window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { this.render(); const el = this.root.querySelector<HTMLInputElement>(".samaya-mt-search"); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, 150);
    };
    if (ps.length > 1) renderSwitch<Period>(right, ps.map(p => [p, NAMES[p].tab, NAMES[p].hint] as [Period, string, string]), memory.period, p => { memory.period = p; memory.shown = PAGE; this.render(); }, "Kind of note");
  }

  // ---- now: one row per kind of note, for the current day / week / month / quarter / year
  private nowSection(page: HTMLElement, need: TFile[]) {
    if (!this.now.length) return;
    const sec = this.section(page, "Now"); const list = sec.createDiv("samaya-mt-list");
    const td = todayYmd();
    for (const n of this.now) {
      const r = this.row(list, "is-now" + (n.file ? "" : " is-missing"), () => { void this.open(n.file, n.p, td); });
      const lab = rowLabel(n.p, td, d => isoWeek(parseYmd(d)), weekRangeLabel);
      const d = r.createDiv("samaya-mt-edate is-today"); d.setText(PERIOD_UI[n.p].now); d.createDiv({ cls: "samaya-jn-esub", text: n.p === "daily" ? lab.main : n.p === "weekly" ? lab.sub : lab.main });
      const body = r.createDiv("samaya-mt-ebody");
      if (n.file) { need.push(n.file); this.preview(body, n.file, n.p); } else body.createDiv({ cls: "samaya-mt-none", text: `No ${PERIOD_UI[n.p].noun} note yet` });
      r.createDiv({ cls: "samaya-jn-meta", text: n.file ? "" : "Create" });
      if (n.file) this.meta(r.lastElementChild as HTMLElement, n.file, n.p);
    }
  }

  // ---- the notes of one kind, newest first, under their month or year
  private listSection(page: HTMLElement, ps: Period[], q: string, need: TFile[]) {
    const p = memory.period; const all = this.lists.get(p) ?? [];
    if (!all.length) { this.section(page, NAMES[p].hint).createDiv({ cls: "samaya-mt-none", text: `No ${NAMES[p].adj} notes yet.` }); return; }
    let items = all;
    if (q) { // reading every note of the kind is the price of searching their text
      need.push(...all.map(n => n.file));
      items = all.filter(n => { const l = rowLabel(p, n.date, d => isoWeek(parseYmd(d)), weekRangeLabel); return `${l.main} ${l.sub} ${n.file.basename}`.toLowerCase().includes(q) || (this.body(n.file) ?? "").toLowerCase().includes(q); });
      if (!items.length) { page.createDiv({ cls: "samaya-mt-none", text: this.loading ? "Searching…" : "No notes match." }); return; }
    }
    const shown = items.slice(0, memory.shown); const ref = todayYmd();
    let last: string | null = null; let list = page;
    for (const n of shown) {
      const g = groupLabel(p, n.date);
      if (g !== last || list === page) { list = this.section(page, g || (ps.length > 1 ? NAMES[p].hint : "Notes")).createDiv("samaya-mt-list"); last = g; }
      if (!q) need.push(n.file);
      const cur = sameSpan(p, n.date, ref); const lab = rowLabel(p, n.date, d => isoWeek(parseYmd(d)), weekRangeLabel);
      const r = this.row(list, cur ? "is-current" : "", () => { void this.open(n.file, p, anchor(p, n.date)); });
      const d = r.createDiv({ cls: "samaya-mt-edate" + (cur ? " is-today" : ""), text: lab.main }); if (lab.sub) d.createDiv({ cls: "samaya-jn-esub", text: lab.sub });
      this.preview(r.createDiv("samaya-mt-ebody"), n.file, p);
      this.meta(r.createDiv("samaya-jn-meta"), n.file, p);
    }
    if (items.length > shown.length) {
      const more = page.createDiv("samaya-jn-more"); const k = Math.min(PAGE, items.length - shown.length);
      const a = more.createSpan({ cls: "samaya-mt-link", text: `Show ${k} more` }); a.onclick = () => { memory.shown += PAGE; this.render(); };
    }
  }

  /** One or two lines of what the note says (nothing while its text is still being read). */
  private preview(el: HTMLElement, f: TFile, p: Period) {
    const text = this.body(f); if (text === null) return;
    const d = digest(text, p); if (!d.lines.length) { el.createDiv({ cls: "samaya-mt-none", text: "Empty" }); return; }
    d.lines.forEach((l, i) => el.createDiv({ cls: "samaya-mt-eline" + (i ? " is-second" : ""), text: l }));
  }
  /** Daily notes: tasks done and time worked, small and on the right. */
  private meta(el: HTMLElement, f: TFile, p: Period) {
    if (p !== "daily") return;
    const text = this.body(f); if (text === null) return;
    const d = digest(text, p); const fm = this.app.metadataCache.getFileCache(f)?.frontmatter; const mins = Number(fm?.work_minutes);
    if (d.finished) el.createDiv({ text: `${d.finished} done` });
    if (mins > 0) el.createDiv({ text: fmtEstimate(Math.round(mins)) });
  }
}
