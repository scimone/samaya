import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type SamayaPlugin from "../main";
import { Period, identifyNote, openPeriodNote, periodLocation, periodNotePath, journalPathFor } from "../journal";
import { breakMinutes, dailyTarget, fmtSigned, periodRange, periodStats, workedMinutes } from "../worktime";
import { nowMin } from "../workday";
import { ConfirmCreateModal } from "../modals";
import { isoWeek, monthGrid } from "../monthgrid";
import { addDays, fmtDur, parseYmd, startOfWeek, today } from "../util";

export const JOURNAL_CAL_TYPE = "samaya-journal-calendar";

/** Month calendar in the sidebar: days open daily notes, week numbers weekly notes, the month and year their notes. */
export class JournalCalendarView extends ItemView {
  private shown = today().slice(0, 7); // YYYY-MM
  private timer = 0;
  /** the period whose work time is summarised below the calendar */
  private sel: { p: Period; date: string } = { p: "daily", date: today() };
  constructor(leaf: WorkspaceLeaf, private plugin: SamayaPlugin) { super(leaf); }
  getViewType() { return JOURNAL_CAL_TYPE; }
  getDisplayText() { return "Journal"; }
  getIcon() { return "calendar"; }

  async onOpen() {
    this.contentEl.addClass("samaya-jcal");
    const again = () => { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render(); }, 80); };
    this.registerEvent(this.app.vault.on("create", again)); this.registerEvent(this.app.vault.on("delete", again)); this.registerEvent(this.app.vault.on("rename", again));
    this.register(this.plugin.bus.on(again));
    this.registerEvent(this.app.metadataCache.on("changed", f => { if (f.extension === "md") again(); })); // work times are properties of the notes
    this.registerEvent(this.app.workspace.on("file-open", f => { void this.follow(f); }));
    this.registerInterval(window.setInterval(again, 10 * 60000)); // the day changes at midnight
    await this.render();
  }
  async onClose() { window.clearTimeout(this.timer); }

  /** Select the period of the note that was opened, wherever it was opened from. */
  private async follow(f: TFile | null) {
    if (!f) return; const id = await identifyNote(this.app, this.plugin.settings, f);
    if (id && (id.p !== this.sel.p || id.date !== this.sel.date)) { this.sel = id; this.shown = id.date.slice(0, 7); void this.render(); }
  }
  private pick(p: Period, date: string) { this.sel = { p, date }; void this.render(); void this.openPeriod(p, date); }
  private async openPeriod(p: Period, date: string) {
    const s = this.plugin.settings;
    const k = p === "daily" ? null : p; // the periodic kind, if any
    const off = !!k && !s.journalNotes[k].on; // this kind of note is not switched on yet: offer to do so
    const cfg = k && off ? { ...s, journalNotes: { ...s.journalNotes, [k]: { ...s.journalNotes[k], on: true } } } : s;
    const hit = await periodNotePath(this.app, cfg, p, date); if (!hit) return;
    if (hit.file) { await this.plugin.openNoteInMain(hit.file); return; }
    new ConfirmCreateModal(this.plugin, hit.path, () => {
      void (async () => {
        if (k && off) { s.journalNotes[k].on = true; await this.plugin.saveSettings(); this.plugin.bus.emit(); }
        const f = await openPeriodNote(this.app, s, p, date); if (f) await this.plugin.openNoteInMain(f);
      })();
    }, off ? `${p[0].toUpperCase() + p.slice(1)} notes are switched off. Creating this note switches them on (see the Journal settings).` : "").open();
  }

  private async render() {
    try { await this.draw(); } catch (e) {
      console.error("Samaya: journal calendar failed", e);
      this.contentEl.empty(); this.contentEl.createDiv({ cls: "samaya-note", text: "The calendar could not be drawn: " + (e as Error).message });
    }
  }
  private async draw() {
    const s = this.plugin.settings; const root = this.contentEl;
    const locs: Record<Period, Awaited<ReturnType<typeof periodLocation>>> = {
      daily: await periodLocation(this.app, s, "daily"), weekly: await periodLocation(this.app, s, "weekly"),
      monthly: await periodLocation(this.app, s, "monthly"), quarterly: await periodLocation(this.app, s, "quarterly"), yearly: await periodLocation(this.app, s, "yearly"),
    };
    const exists = (p: Period, date: string) => { const l = locs[p]; return !!l && this.app.vault.getAbstractFileByPath(journalPathFor(l, date)) instanceof TFile; };
    root.empty();
    const [y, m] = this.shown.split("-").map(Number); const td = today();
    const first = `${this.shown}-01`;

    const head = root.createDiv("samaya-jcal-head");
    const go = (n: number) => { const d = new Date(y, m - 1 + n, 1); this.shown = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; void this.render(); };
    head.createEl("button", { text: "«", cls: "samaya-mini", attr: { title: "Previous year" } }).onclick = () => go(-12);
    head.createEl("button", { text: "‹", cls: "samaya-mini", attr: { title: "Previous month" } }).onclick = () => go(-1);
    const title = head.createDiv("samaya-jcal-title");
    const link = (text: string, p: Period, date: string) => {
      const el = title.createSpan({ text });
      el.addClass("is-link"); el.toggleClass("has-note", exists(p, date)); el.onclick = () => this.pick(p, date);
    };
    link(new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long" }), "monthly", first);
    link(String(y), "yearly", `${y}-01-01`);
    const q = Math.floor((m - 1) / 3);
    const qEl = title.createSpan({ text: `Q${q + 1}`, cls: "is-link samaya-jcal-quarter" }); const qDate = `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`;
    qEl.toggleClass("has-note", exists("quarterly", qDate)); qEl.onclick = () => this.pick("quarterly", qDate);
    head.createEl("button", { text: "›", cls: "samaya-mini", attr: { title: "Next month" } }).onclick = () => go(1);
    head.createEl("button", { text: "»", cls: "samaya-mini", attr: { title: "Next year" } }).onclick = () => go(12);
    head.createEl("button", { text: "Today", cls: "samaya-mini" }).onclick = () => { this.shown = td.slice(0, 7); void this.render(); };

    const grid = root.createDiv("samaya-jcal-grid");
    grid.createDiv({ cls: "samaya-jcal-dow", text: "W" });
    const mon = startOfWeek(td); // any Monday: only used for the weekday names
    for (let i = 0; i < 7; i++) grid.createDiv({ cls: "samaya-jcal-dow", text: new Date(`${addDays(mon, i)}T12:00:00`).toLocaleDateString(undefined, { weekday: "narrow" }) });
    for (const w of monthGrid(y, m - 1)) {
      const wk = grid.createDiv({ cls: "samaya-jcal-wk", text: String(w.week) });
      wk.toggleClass("is-selected", this.sel.p === "weekly" && this.sel.date >= w.start && this.sel.date <= addDays(w.start, 6)); wk.addClass("is-link"); wk.toggleClass("has-note", exists("weekly", w.start)); wk.onclick = () => this.pick("weekly", w.start);
      for (const d of w.days) {
        const c = grid.createDiv({ cls: "samaya-jcal-day", text: String(Number(d.date.slice(8))) });
        c.toggleClass("is-selected", this.sel.p === "daily" && this.sel.date === d.date); c.toggleClass("is-other", !d.inMonth); c.toggleClass("is-today", d.date === td); c.toggleClass("has-note", exists("daily", d.date));
        c.onclick = () => this.pick("daily", d.date);
      }
    }
    this.drawInfo(root.createDiv("samaya-jcal-info"));
  }

  /** Work time of the selected day, or aggregates over the selected week / month / quarter / year. */
  private drawInfo(box: HTMLElement) {
    const s = this.plugin.settings; const { p, date } = this.sel; const logs = this.plugin.workday.allLogs();
    const { from, to } = periodRange(p, date); const f = (d: string) => parseYmd(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const [y, m] = date.split("-").map(Number);
    box.createDiv({ cls: "samaya-jcal-info-title", text: {
      daily: parseYmd(date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
      weekly: `Week ${isoWeek(from)} · ${f(from)} – ${f(to)}`,
      monthly: parseYmd(date).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      quarterly: `Q${Math.floor((m - 1) / 3) + 1} ${y}`, yearly: String(y),
    }[p] });
    const rows = box.createDiv("samaya-jcal-info-rows");
    const row = (label: string, value: string, cls = "") => { rows.createSpan({ cls: "samaya-jcal-info-label", text: label }); rows.createSpan({ cls, text: value }); };
    if (p === "daily") {
      const live = this.plugin.workday.log?.date === date ? this.plugin.workday.log : null;
      const log = logs.find(l => l.date === date) ?? live;
      if (!log?.start) { box.createDiv({ cls: "samaya-jcal-info-empty", text: "No work time logged." }); return; }
      const running = !log.end; const worked = workedMinutes(log, date === today() ? nowMin() : 1440); const target = dailyTarget(s.weeklyHours, s.workDays, date);
      row("Started", log.start); row("Finished", log.end ? log.end + (log.endAuto ? " (auto)" : "") : "still running");
      row("Breaks", fmtDur(breakMinutes(log))); row("Worked", fmtDur(worked));
      if (target) row("Required", fmtDur(target));
      if (target && !running) { const d = worked - target; row("Over / under", fmtSigned(d), d < 0 ? "is-neg" : "is-pos"); }
      return;
    }
    const st = periodStats(logs, from, to, s.weeklyHours, s.workDays);
    if (!st.days) { box.createDiv({ cls: "samaya-jcal-info-empty", text: "No finished workdays logged." }); return; }
    row("Days worked", String(st.days)); row("Average start", st.avgStart!); row("Average end", st.avgEnd!);
    row("Average per day", fmtDur(st.avgWorked)); row("Total worked", fmtDur(st.worked)); row("Required", fmtDur(st.target));
    row("Over / under", fmtSigned(st.balance), st.balance < 0 ? "is-neg" : "is-pos");
  }
}
