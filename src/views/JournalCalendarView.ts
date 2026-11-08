import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type SamayaPlugin from "../main";
import { Period, openPeriodNote, periodLocation, journalPathFor } from "../journal";
import { monthGrid } from "../monthgrid";
import { addDays, startOfWeek, today } from "../util";

export const JOURNAL_CAL_TYPE = "samaya-journal-calendar";

/** Month calendar in the sidebar: days open daily notes, week numbers weekly notes, the month and year their notes. */
export class JournalCalendarView extends ItemView {
  private shown = today().slice(0, 7); // YYYY-MM
  private timer = 0;
  constructor(leaf: WorkspaceLeaf, private plugin: SamayaPlugin) { super(leaf); }
  getViewType() { return JOURNAL_CAL_TYPE; }
  getDisplayText() { return "Journal"; }
  getIcon() { return "calendar"; }

  async onOpen() {
    this.contentEl.addClass("samaya-jcal");
    const again = () => { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render(); }, 80); };
    this.registerEvent(this.app.vault.on("create", again)); this.registerEvent(this.app.vault.on("delete", again)); this.registerEvent(this.app.vault.on("rename", again));
    this.register(this.plugin.bus.on(again));
    this.registerInterval(window.setInterval(again, 10 * 60000)); // the day changes at midnight
    await this.render();
  }
  async onClose() { window.clearTimeout(this.timer); }

  /** Open in the main area: reuse a tab already showing the file, else the first note tab, else a new tab. */
  private async show(file: TFile) {
    let same: WorkspaceLeaf | null = null, note: WorkspaceLeaf | null = null;
    this.app.workspace.iterateRootLeaves(l => {
      if ((l.view as { file?: TFile }).file?.path === file.path) same = l;
      else if (!note && l.view.getViewType() === "markdown") note = l;
    });
    const leaf: WorkspaceLeaf = same ?? note ?? this.app.workspace.getLeaf("tab");
    if (!same) await leaf.openFile(file);
    await this.app.workspace.revealLeaf(leaf);
  }
  private async open(p: Period, date: string) {
    const f = await openPeriodNote(this.app, this.plugin.settings, p, date);
    if (f) await this.show(f);
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
      monthly: await periodLocation(this.app, s, "monthly"), yearly: await periodLocation(this.app, s, "yearly"),
    };
    const exists = (p: Period, date: string) => { const l = locs[p]; return !!l && this.app.vault.getAbstractFileByPath(journalPathFor(l, date)) instanceof TFile; };
    root.empty();
    const [y, m] = this.shown.split("-").map(Number); const td = today();
    const first = `${this.shown}-01`;

    const head = root.createDiv("samaya-jcal-head");
    const go = (n: number) => { const d = new Date(y, m - 1 + n, 1); this.shown = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; void this.render(); };
    head.createEl("button", { text: "‹", cls: "samaya-mini" }).onclick = () => go(-1);
    const title = head.createDiv("samaya-jcal-title");
    const link = (text: string, p: Period, date: string) => {
      const el = title.createSpan({ text });
      if (locs[p]) { el.addClass("is-link"); el.toggleClass("has-note", exists(p, date)); el.onclick = () => { void this.open(p, date); }; }
    };
    link(new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long" }), "monthly", first);
    link(String(y), "yearly", `${y}-01-01`);
    head.createEl("button", { text: "›", cls: "samaya-mini" }).onclick = () => go(1);
    head.createEl("button", { text: "Today", cls: "samaya-mini" }).onclick = () => { this.shown = td.slice(0, 7); void this.render(); };

    const grid = root.createDiv("samaya-jcal-grid");
    grid.createDiv({ cls: "samaya-jcal-dow", text: "W" });
    const mon = startOfWeek(td); // any Monday: only used for the weekday names
    for (let i = 0; i < 7; i++) grid.createDiv({ cls: "samaya-jcal-dow", text: new Date(`${addDays(mon, i)}T12:00:00`).toLocaleDateString(undefined, { weekday: "narrow" }) });
    for (const w of monthGrid(y, m - 1)) {
      const wk = grid.createDiv({ cls: "samaya-jcal-wk", text: String(w.week) });
      if (locs.weekly) { wk.addClass("is-link"); wk.toggleClass("has-note", exists("weekly", w.start)); wk.onclick = () => { void this.open("weekly", w.start); }; }
      for (const d of w.days) {
        const c = grid.createDiv({ cls: "samaya-jcal-day", text: String(Number(d.date.slice(8))) });
        c.toggleClass("is-other", !d.inMonth); c.toggleClass("is-today", d.date === td); c.toggleClass("has-note", exists("daily", d.date));
        c.onclick = () => { void this.open("daily", d.date); };
      }
    }
  }
}
