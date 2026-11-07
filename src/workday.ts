import { App, Menu, Notice } from "obsidian";
import type SamayaPlugin from "./main";
import { setJournalProps } from "./journal";
import { Break, BreakKind, DayLog, autoLunch, breakMinutes, fmtBreak, parseBreak, workedMinutes } from "./worktime";
import { fmtDur, hmToMin, minToHm, today } from "./util";

export const nowHm = (): string => { const d = new Date(); return minToHm(d.getHours() * 60 + d.getMinutes()); };
export const nowMin = (): number => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/** Read all logged workdays from the daily notes' properties (work_start / work_end / breaks). */
export function readLogs(app: App): DayLog[] {
  const out: DayLog[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    if (!fm || !fm.work_start || !fm.date) continue;
    const date = String(fm.date).slice(0, 10);
    const raw = Array.isArray(fm.breaks) ? fm.breaks : fm.breaks ? [fm.breaks] : [];
    out.push({ date, start: String(fm.work_start), end: fm.work_end ? String(fm.work_end) : null, endAuto: fm.work_end_auto === true,
      breaks: raw.map(parseBreak).filter((b): b is Break => !!b), open: null });
  }
  return out;
}

export class WorkdayManager {
  log: DayLog | null = null;
  private statusEl: HTMLElement | null = null;
  constructor(private plugin: SamayaPlugin) {}
  private get s() { return this.plugin.settings; }

  get started(): boolean { return !!this.log?.start && !this.log.end; }
  get onBreak(): boolean { return !!this.log?.open; }
  worked(): number { return workedMinutes(this.log, nowMin()); }

  init(statusEl: HTMLElement, saved: DayLog | null) {
    this.statusEl = statusEl; statusEl.addClass("samaya-status");
    statusEl.addEventListener("click", e => this.menu(e));
    this.log = saved;
    void this.rollover();
    const plugin = this.plugin;
    plugin.registerInterval(window.setInterval(() => this.tick(), 30000));
    this.paintStatus();
    plugin.registerInterval(window.setInterval(() => this.paintStatus(), 15000));
  }

  /** Remember the last time we saw the day running, so a forgotten day can be closed sensibly. */
  private tick() {
    void this.rollover();
    const l = this.log; if (!l || !this.started) return;
    l.seen = nowHm(); void this.plugin.saveData(this.plugin.data);
  }

  /** A day that was never ended is closed at the last time we saw activity. */
  private async rollover() {
    const l = this.log; if (!l || l.date === today()) return;
    if (l.start && !l.end) {
      if (l.open) { l.breaks.push({ ...l.open, end: l.seen ?? l.open.start }); l.open = null; }
      l.end = l.seen && hmToMin(l.seen) > hmToMin(l.start) ? l.seen : l.start; l.endAuto = true;
      const lunch = this.s.autoLunch ? autoLunch(l, this.plugin.lunchFor(l.date)) : null; if (lunch) l.breaks.push(lunch);
      await this.writeProps(l);
      new Notice(`Samaya: ${l.date} was not ended - closed at ${l.end}. Edit work_end in that daily note if needed.`, 8000);
    }
    this.log = null; await this.persist(); this.plugin.bus.emit();
  }

  private async persist() { this.plugin.data.workday = this.log; await this.plugin.saveData(this.plugin.data); }
  private async writeProps(l: DayLog) {
    const worked = workedMinutes(l, nowMin());
    await setJournalProps(this.plugin.app, this.s, l.date, {
      date: l.date, lunch: `${minToHm(this.plugin.lunchFor(l.date)[0])}-${minToHm(this.plugin.lunchFor(l.date)[1])}`, work_start: l.start, work_end: l.end, work_end_auto: l.endAuto ? true : null,
      breaks: l.breaks.map(fmtBreak), break_minutes: breakMinutes(l) || null, work_minutes: l.end ? worked : null,
    });
  }
  private async commit() { if (this.log) await this.writeProps(this.log); await this.persist(); this.paintStatus(); this.plugin.bus.emit(); }

  async reopenDay() { const l = this.log; if (!l || !l.end) return; l.end = null; l.endAuto = false; await this.commit(); }
  async startDay(at = nowHm()) {
    if (this.started) return;
    if (this.log && this.log.date === today() && this.log.end) return this.reopenDay();
    this.log = { date: today(), start: at, end: null, breaks: [], open: null, seen: at };
    await this.commit(); new Notice(`Workday started at ${at}`);
  }
  async startBreak(kind: BreakKind = "break", at = nowHm()) {
    if (!this.started) await this.startDay();
    const l = this.log!; if (l.open) return;
    l.open = { start: at, kind }; if (this.plugin.focus.state?.startedAt) await this.plugin.focus.pause();
    await this.commit();
  }
  async endBreak(at = nowHm()) {
    const l = this.log; if (!l?.open) return;
    if (hmToMin(at) > hmToMin(l.open.start)) l.breaks.push({ start: l.open.start, end: at, kind: l.open.kind });
    l.open = null; await this.commit();
  }
  async endDay(at = nowHm()) {
    const l = this.log; if (!l || !this.started) return;
    if (l.open) await this.endBreak(at);
    l.end = at;
    const lunch = this.s.autoLunch ? autoLunch(l, this.plugin.lunchFor(l.date)) : null;
    if (lunch) { l.breaks.push(lunch); new Notice(`No lunch logged - subtracted the default ${lunch.start}-${lunch.end}`); }
    await this.commit();
    new Notice(`Workday ended at ${at} - worked ${fmtDur(workedMinutes(l, nowMin()))}`);
  }

  private paintStatus() {
    const el = this.statusEl; if (!el) return;
    const l = this.log;
    el.toggleClass("is-break", !!l?.open);
    if (!l || !l.start) el.setText("Start day");
    else if (l.end) el.setText(`Done · ${fmtDur(workedMinutes(l, nowMin()))}`);
    else if (l.open) el.setText(`Break · ${fmtDur(nowMin() - hmToMin(l.open.start))}`);
    else el.setText(`Working · ${fmtDur(this.worked())}`);
  }
  private menu(e: MouseEvent) {
    const m = new Menu(); const p = this.plugin;
    if (!this.started) {
      m.addItem(i => i.setTitle("Plan my day (guided)").onClick(() => p.startGuide()));
      m.addItem(i => i.setTitle("Start workday now").onClick(() => { void this.startDay(); }));
    } else {
      if (this.onBreak) m.addItem(i => i.setTitle("Back to work").onClick(() => { void this.endBreak(); }));
      else m.addItem(i => i.setTitle("Start break").onClick(() => { void this.startBreak(); }));
      m.addItem(i => i.setTitle("End workday (shutdown)").onClick(() => p.startShutdown()));
    }
    m.addSeparator(); m.addItem(i => i.setTitle("Work time dashboard").onClick(() => { void p.openDashboard(); }));
    m.showAtMouseEvent(e);
  }
}
