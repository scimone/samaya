import { TFile, setIcon } from "obsidian";
import { Panel } from "./panel";
import { openFileSmart } from "../openfile";
import { ConfirmCreateModal } from "../modals";
import type SamayaPlugin from "../main";
import { PERIODIC_KINDS, PERIOD_UI, Period, listPeriodNotes, openPeriodNote, periodNotePath } from "../journal";
import { anchor, rowLabel, spanKey, spanStart } from "../journaldigest";
import { monthGrid } from "../monthgrid";
import { addDays, parseYmd, today as todayYmd, ymd } from "../util";
import { isoWeek, renderHeadTitle, weekRangeLabel } from "./plannerHead";

interface Note { file: TFile; date: string }

const KIND: Record<Period, string> = { daily: "Day", weekly: "Week", monthly: "Month", quarterly: "Quarter", yearly: "Year" };
const RECENT = 5;

/** The month the calendar shows, kept for the session so coming back lands where you were. */
const memory = { year: 0, month: -1 };

/**
 * The journal as a dashboard: a row of "jump to" cards (today, this week, month, quarter, year: the kinds switched on in the settings),
 * a month calendar whose days, week numbers, month, quarter and year are all buttons, and the latest entries.
 * Everything opens the note in a tab; one that does not exist yet is only created after the user confirms.
 */
export class JournalView extends Panel {
  private root: HTMLElement;
  private timer = 0; private seq = 0;
  private lists = new Map<Period, Note[]>(); private has = new Map<Period, Set<string>>(); // which spans have a note
  private on: Period[] = [];

  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) { super(plugin); this.root = parentEl.createDiv("samaya-mt samaya-jn"); }
  onload() {
    super.onload();
    this.register(this.plugin.bus.on(() => this.onDataUpdated())); // the settings decide which kinds of notes exist
    const tick = window.setInterval(() => { if (this.root.isShown()) this.onDataUpdated(); }, 5 * 60000); // midnight: "Today" moves on
    this.register(() => window.clearInterval(tick));
  }
  onunload() { window.clearTimeout(this.timer); this.seq++; }
  onDataUpdated(): void { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.reload(); }, 150); }

  private periods(): Period[] { const s = this.plugin.settings; return s.journalOn ? ["daily", ...PERIODIC_KINDS.filter(k => s.journalNotes[k].on)] : []; }

  /** Find the notes (names only, nothing is read), then draw. */
  private async reload() {
    const seq = ++this.seq; const s = this.plugin.settings; const ps = this.periods(); const lists = new Map<Period, Note[]>(); const has = new Map<Period, Set<string>>();
    for (const p of ps) {
      const l = (await listPeriodNotes(this.app, s, p)).reverse(); lists.set(p, l);
      has.set(p, new Set(l.map(n => spanKey(p, n.date))));
    }
    if (seq !== this.seq) return; // a newer load is under way
    this.lists = lists; this.has = has; this.on = ps; this.render();
  }

  private exists(p: Period, date: string): boolean { return this.has.get(p)?.has(spanKey(p, date, false)) ?? false; }

  /** Open the note of the span containing `date` in a tab. A missing one is created first, but only once the user agrees. */
  private async go(p: Period, date: string) {
    const at = spanStart(p, date); const info = await periodNotePath(this.app, this.plugin.settings, p, at); if (!info) return;
    const open = async (f: TFile | null) => { const file = f ?? await openPeriodNote(this.app, this.plugin.settings, p, at); if (file) openFileSmart(this.app, file, "tab"); };
    if (info.file) void open(info.file);
    else new ConfirmCreateModal(this.plugin, info.path, () => { void open(null); }, `A new ${PERIOD_UI[p].noun} note for ${this.spanName(p, at)}.`).open();
  }
  private spanName(p: Period, date: string): string {
    const d = parseYmd(date), l = rowLabel(p, date, w => isoWeek(parseYmd(w)), weekRangeLabel);
    switch (p) {
      case "daily": return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      case "weekly": return `${l.main} (${l.sub})`;
      case "monthly": return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      case "quarterly": return `${l.main} ${d.getFullYear()}`;
      case "yearly": return String(d.getFullYear());
    }
  }
  /** A button that opens (or offers to create) the note of a span, marked when the note exists; plain text when that kind of note is switched off. */
  private target(parent: HTMLElement, p: Period, date: string, text: string, cls: string): HTMLElement {
    if (!this.on.includes(p)) return parent.createSpan({ cls, text });
    const ex = this.exists(p, date); const name = this.spanName(p, spanStart(p, date));
    const b = parent.createEl("button", { cls: `${cls} samaya-jn-hit${ex ? " has-note" : ""}`, text, attr: { title: ex ? `Open ${name}` : `${name}: not written yet. Create it`, "aria-label": `${ex ? "Open" : "Create"} ${PERIOD_UI[p].noun} note, ${name}` } });
    b.onclick = () => { void this.go(p, date); };
    return b;
  }

  private render() {
    const y = this.root.querySelector<HTMLElement>(".samaya-mt-page")?.scrollTop ?? 0;
    this.root.empty();
    const head = this.root.createDiv("samaya-week-head samaya-day-head samaya-mt-head");
    renderHeadTitle(head, "Journal", "\u00a0"); // no subheading; the blank line keeps the bar as tall as the planner's
    const page = this.root.createDiv("samaya-mt-page").createDiv("samaya-mt-col");
    if (!this.on.length) { page.createDiv({ cls: "samaya-mt-none", text: "The journal is switched off. Turn it on in the settings." }); return; }
    if (memory.month < 0) { const t = parseYmd(todayYmd()); memory.year = t.getFullYear(); memory.month = t.getMonth(); }
    this.calendar(page.createDiv("samaya-jn-main")); // the calendar on the left, the quick jumps and latest entries beside it
    const side = page.createDiv("samaya-jn-side"); this.jump(side); this.recent(side);
    if (y) this.root.querySelector<HTMLElement>(".samaya-mt-page")!.scrollTop = y;
  }

  // ---- jump to: one card per kind of note, for the current day / week / month / quarter / year
  private jump(page: HTMLElement) {
    const sec = page.createDiv("samaya-mt-section"); sec.createDiv({ cls: "samaya-mt-h", text: "Jump to" });
    const row = sec.createDiv("samaya-jn-cards"); const td = todayYmd();
    for (const p of this.on) {
      const ex = this.exists(p, td); const l = rowLabel(p, spanStart(p, td), w => isoWeek(parseYmd(w)), weekRangeLabel); const d = parseYmd(td);
      const title = p === "daily" ? d.toLocaleDateString(undefined, { weekday: "long" }) : l.main;
      const sub = p === "daily" ? d.toLocaleDateString(undefined, { month: "long", day: "numeric" }) : p === "quarterly" ? this.quarterMonths(td) : p === "yearly" ? "" : l.sub;
      const card = row.createEl("button", { cls: `samaya-jn-card is-${p}${ex ? "" : " is-missing"}`, attr: { title: ex ? `Open ${this.spanName(p, td)}` : `${this.spanName(p, td)}: not written yet. Create it` } });
      card.onclick = () => { void this.go(p, td); };
      card.createDiv({ cls: "samaya-jn-card-kicker", text: PERIOD_UI[p].now });
      card.createDiv({ cls: "samaya-jn-card-title", text: title });
      if (sub) card.createDiv({ cls: "samaya-jn-card-sub", text: sub });
      const foot = card.createDiv("samaya-jn-card-foot");
      const act = foot.createSpan("samaya-jn-card-act"); setIcon(act.createSpan(), ex ? "arrow-up-right" : "plus"); act.createSpan({ text: ex ? "Open" : "Create" });
      const bar = card.createDiv("samaya-jn-card-bar"); bar.createDiv("samaya-jn-card-fill").style.width = `${Math.round(this.elapsed(p, td) * 100)}%`;
    }
  }
  /** "Oct – Dec" for the quarter of a date. */
  private quarterMonths(date: string): string {
    const s = parseYmd(spanStart("quarterly", date)); const e = new Date(s.getFullYear(), s.getMonth() + 2, 1); const m = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
    return `${m(s)} – ${m(e)}`;
  }
  /** How far through its span now is (0-1): the thin bar on each card. */
  private elapsed(p: Period, date: string): number {
    const s = parseYmd(spanStart(p, date)); let e: Date;
    switch (p) {
      case "daily": e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1); break;
      case "weekly": e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7); break;
      case "monthly": e = new Date(s.getFullYear(), s.getMonth() + 1, 1); break;
      case "quarterly": e = new Date(s.getFullYear(), s.getMonth() + 3, 1); break;
      case "yearly": e = new Date(s.getFullYear() + 1, 0, 1); break;
    }
    return Math.min(1, Math.max(0, (Date.now() - s.getTime()) / (e.getTime() - s.getTime())));
  }

  // ---- the calendar: month, quarter and year in its heading, then week numbers and days
  private calendar(page: HTMLElement) {
    const sec = page.createDiv("samaya-mt-section"); sec.createDiv({ cls: "samaya-mt-h", text: "Calendar" });
    const box = sec.createDiv("samaya-jn-cal"); const td = todayYmd();
    const first = ymd(new Date(memory.year, memory.month, 1)); const isNow = first === spanStart("monthly", td);
    const step = (n: number) => { const d = new Date(memory.year, memory.month + n, 1); memory.year = d.getFullYear(); memory.month = d.getMonth(); this.render(); };

    const head = box.createDiv("samaya-jn-cal-head");
    const title = head.createDiv("samaya-jn-cal-title");
    this.target(title, "monthly", first, parseYmd(first).toLocaleDateString(undefined, { month: "long" }), "samaya-jn-cal-month");
    this.target(title, "yearly", first, String(memory.year), "samaya-jn-cal-year");
    this.target(title, "quarterly", first, `Q${Math.floor(memory.month / 3) + 1}`, "samaya-jn-cal-q");
    const nav = head.createDiv("samaya-jn-cal-nav");
    if (!isNow) { const t = nav.createEl("button", { cls: "samaya-jn-pill", text: "Today", attr: { title: "Back to the current month" } }); t.onclick = () => { const d = parseYmd(td); memory.year = d.getFullYear(); memory.month = d.getMonth(); this.render(); }; }
    const prev = nav.createEl("button", { cls: "samaya-jn-step", attr: { title: "Previous month", "aria-label": "Previous month" } }); setIcon(prev, "chevron-left"); prev.onclick = () => step(-1);
    const next = nav.createEl("button", { cls: "samaya-jn-step", attr: { title: "Next month", "aria-label": "Next month" } }); setIcon(next, "chevron-right"); next.onclick = () => step(1);

    const grid = box.createDiv("samaya-jn-grid"); const weekly = this.on.includes("weekly");
    grid.createDiv({ cls: "samaya-jn-dow is-wk", text: "Wk" });
    for (let i = 0; i < 7; i++) grid.createDiv({ cls: "samaya-jn-dow" + (i > 4 ? " is-weekend" : ""), text: parseYmd(addDays("2024-01-01", i)).toLocaleDateString(undefined, { weekday: "short" }) });
    const curWeek = spanKey("weekly", td, false);
    for (const w of monthGrid(memory.year, memory.month)) {
      const live = w.start === curWeek;
      const wk = this.target(grid, "weekly", w.start, String(w.week), "samaya-jn-wk"); if (live) wk.addClass("is-current"); if (!weekly) wk.addClass("is-plain");
      for (const [i, d] of w.days.entries()) {
        const cell = this.target(grid, "daily", d.date, String(parseYmd(d.date).getDate()), "samaya-jn-day");
        if (!d.inMonth) cell.addClass("is-out"); if (i > 4) cell.addClass("is-weekend"); if (d.date === td) cell.addClass("is-today"); if (live) cell.addClass("in-current-week");
      }
    }
    const legend = box.createDiv("samaya-jn-legend");
    legend.createSpan({ cls: "samaya-jn-key", text: "Written" }); legend.createSpan({ cls: "samaya-jn-key is-empty", text: "Not yet · click to create" });
  }

  // ---- the latest entries, newest first: just where they are, no previews
  private recent(page: HTMLElement) {
    const all = this.on.flatMap(p => (this.lists.get(p) ?? []).map(n => ({ p, n, key: anchor(p, n.date) })));
    if (!all.length) return;
    const td = todayYmd();
    const items = all.filter(i => i.key <= td).sort((a, b) => b.key.localeCompare(a.key) || this.on.indexOf(b.p) - this.on.indexOf(a.p)).slice(0, RECENT);
    if (!items.length) return;
    const sec = page.createDiv("samaya-mt-section"); sec.createDiv({ cls: "samaya-mt-h", text: "Recent entries" });
    const list = sec.createDiv("samaya-jn-recent");
    for (const { p, n, key } of items) {
      const r = list.createEl("button", { cls: "samaya-jn-rrow" }); r.onclick = () => { openFileSmart(this.app, n.file, "tab"); };
      r.createSpan({ cls: `samaya-jn-badge is-${p}`, text: KIND[p] });
      r.createSpan({ cls: "samaya-jn-rname", text: this.spanName(p, key) });
    }
  }
}
