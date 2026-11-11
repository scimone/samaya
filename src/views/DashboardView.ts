import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { addDays, fmtDur, parseYmd, startOfWeek, today } from "../util";
import { nowMin, readLogs } from "../workday";
import { DayLog, breakMinutes, fmtSigned, totalBalance, weekSummary } from "../worktime";

export const DASHBOARD_VIEW_TYPE = "samaya-dashboard";

/** The work time dashboard as a panel: the standalone tab and the Planner (with a "Planner" button back) both host it. */
export class DashboardPanel {
  private weekStart = startOfWeek(today());
  private timer = 0;
  constructor(private plugin: SamayaPlugin, private c: HTMLElement, private back?: () => void) { c.addClass("samaya-dash"); }
  dispose() { window.clearTimeout(this.timer); }
  schedule() { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.render(), 150); }

  private logs(): DayLog[] { return this.plugin.workday.allLogs(); }

  render() {
    const c = this.c; c.empty(); const s = this.plugin.settings;
    const logs = this.logs(); const wk = weekSummary(logs, this.weekStart, s.weeklyHours, s.workDays, today(), nowMin());
    const total = totalBalance(logs, s.weeklyHours, s.workDays);

    const head = c.createDiv("samaya-dash-head");
    if (this.back) { const bk = head.createEl("button", { cls: "samaya-dash-back mod-cta", attr: { "aria-label": "Back to the planner (Esc)" } }); setIcon(bk.createSpan("samaya-dash-back-icon"), "arrow-left"); bk.createSpan({ text: "Planner" }); bk.onclick = this.back; }
    head.createEl("h2", { text: "Work time" });
    const nav = head.createDiv("samaya-nav");
    nav.createEl("button", { text: "‹" }).onclick = () => { this.weekStart = addDays(this.weekStart, -7); this.render(); };
    nav.createEl("button", { text: "This week" }).onclick = () => { this.weekStart = startOfWeek(today()); this.render(); };
    nav.createEl("button", { text: "›" }).onclick = () => { this.weekStart = addDays(this.weekStart, 7); this.render(); };
    const f = (d: string) => parseYmd(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    head.createSpan({ cls: "samaya-dash-range", text: `${f(this.weekStart)} – ${f(addDays(this.weekStart, 6))}` });

    const tiles = c.createDiv("samaya-dash-tiles");
    const tile = (label: string, value: string, cls = "", sub = "") => {
      const t = tiles.createDiv("samaya-dash-tile"); t.createDiv({ cls: "samaya-dash-tile-label", text: label });
      t.createDiv({ cls: "samaya-dash-tile-value " + cls, text: value }); if (sub) t.createDiv({ cls: "samaya-dash-tile-sub", text: sub });
    };
    tile("Worked this week", fmtDur(wk.worked), "", `of ${fmtDur(wk.target)} required`);
    tile("Overtime this week", fmtSigned(wk.balance), wk.balance < 0 ? "is-neg" : "is-pos", "finished days only");
    tile("Overtime balance", fmtSigned(total), total < 0 ? "is-neg" : "is-pos", "all logged days");

    const maxMin = Math.max(600, ...wk.rows.map(r => Math.max(r.worked, r.target)));
    const table = c.createDiv("samaya-dash-table");
    const hdr = table.createDiv("samaya-dash-row is-head");
    ["Day", "Start", "End", "Breaks", "Worked", "Target", "+/-"].forEach(h => hdr.createSpan({ text: h }));
    hdr.createSpan({ text: "" });
    wk.rows.forEach(r => {
      const row = table.createDiv("samaya-dash-row" + (r.isToday ? " is-today" : "") + (!r.log && !r.target ? " is-off" : ""));
      row.createSpan({ cls: "samaya-dash-day", text: parseYmd(r.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) });
      row.createSpan({ text: r.log?.start ?? "–" });
      row.createSpan({ text: r.log?.end ? r.log.end + (r.log.endAuto ? " (auto)" : "") : r.log?.start ? "…" : "–" });
      const br = r.log ? breakMinutes(r.log) : 0;
      row.createSpan({ text: r.log ? fmtDur(br) : "–", attr: { title: r.log?.breaks.map(b => `${b.start}-${b.end} ${b.kind}`).join("\n") ?? "" } });
      row.createSpan({ cls: "samaya-dash-worked", text: r.log ? fmtDur(r.worked) : "–" });
      row.createSpan({ text: r.target ? fmtDur(r.target) : "–" });
      row.createSpan({ cls: r.delta === null ? "" : r.delta < 0 ? "is-neg" : "is-pos", text: r.delta === null ? (r.log ? "live" : "") : fmtSigned(r.delta) });
      const bar = row.createDiv("samaya-dash-bar");
      if (r.target) bar.createDiv("samaya-dash-bar-target").style.left = `${(r.target / maxMin) * 100}%`;
      const fill = bar.createDiv("samaya-dash-bar-fill"); fill.style.width = `${(r.worked / maxMin) * 100}%`; fill.toggleClass("is-over", r.target > 0 && r.worked > r.target);
    });
    c.createDiv({ cls: "samaya-dash-note", text: "Times come from the work_start, work_end and breaks properties of your daily notes - edit them there to correct a day." });
  }
}

export class DashboardView extends ItemView {
  private panel: DashboardPanel;
  constructor(leaf: WorkspaceLeaf, private plugin: SamayaPlugin) { super(leaf); this.panel = new DashboardPanel(plugin, this.contentEl); }
  getViewType() { return DASHBOARD_VIEW_TYPE; }
  getDisplayText() { return "Work time"; }
  getIcon() { return "bar-chart-3"; }
  async onOpen() {
    this.registerEvent(this.app.metadataCache.on("changed", () => this.panel.schedule()));
    this.register(this.plugin.bus.on(() => this.panel.schedule()));
    this.registerInterval(window.setInterval(() => this.panel.render(), 30000));
    this.panel.render();
  }
  onClose() { this.panel.dispose(); return Promise.resolve(); }
}
