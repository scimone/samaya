import { App, Notice } from "obsidian";
import type SamayaPlugin from "./main";
import { journalWants, setJournalProps } from "./journal";
import { Break, BreakKind, DayLog, autoLunch, breakMinutes, fmtBreak, parseBreak, workedOn } from "./worktime";
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
  constructor(private plugin: SamayaPlugin) {}
  private get s() { return this.plugin.settings; }

  /** All logged days from the daily notes; today's live state wins. */
  allLogs(): DayLog[] {
    const logs = readLogs(this.plugin.app).filter(l => l.date !== this.log?.date);
    if (this.log?.start) logs.push(this.log);
    return logs;
  }
  get started(): boolean { return !!this.log?.start && !this.log.end; }
  get onBreak(): boolean { return !!this.log?.open; }
  worked(): number { return workedOn(this.log, nowMin(), this.plugin.dayRules); }

  init(saved: DayLog | null) {
    this.log = saved;
    void this.rollover();
    const plugin = this.plugin;
    plugin.registerInterval(window.setInterval(() => this.tick(), 30000));
  }

  /** Remember the last time we saw the day running, so a forgotten day can be closed sensibly. */
  private tick() {
    void this.rollover();
    const l = this.log; if (!l || !this.started) return;
    const hm = nowHm(); if (l.seen === hm) return; // `seen` has minute resolution: one write a minute, not two
    l.seen = hm; void this.plugin.saveData(this.plugin.data);
  }

  /** A day that was never ended is closed at the last time we saw activity. */
  private rolling = false;
  private async rollover() {
    const l = this.log; if (!l || l.date === today() || this.rolling) return; // the 30s tick must not start a second run while a slow write is in flight
    this.rolling = true;
    try { await this.rolloverNow(l); } finally { this.rolling = false; }
  }
  private async rolloverNow(l: DayLog) {
    if (l.start && !l.end) {
      // the last time we saw the day running; without one, the finish line of that day's timeline (never before the start)
      const winEnd = this.plugin.workWindowFor(l.date)[1];
      const end = l.seen && hmToMin(l.seen) > hmToMin(l.start) ? l.seen : winEnd > hmToMin(l.start) ? minToHm(winEnd) : l.start;
      if (l.open) { l.breaks.push({ ...l.open, end: hmToMin(end) > hmToMin(l.open.start) ? end : l.open.start }); l.open = null; }
      l.end = end; l.endAuto = true;
      const lunch = this.s.autoLunch ? autoLunch(l, this.plugin.lunchFor(l.date)) : null; if (lunch) l.breaks.push(lunch);
      await this.writeProps(l);
      try { await this.plugin.writeDayClose(l.date); } catch (e) { console.warn("Samaya: could not write the closed day to its note", e); } // the same sections as a manual shutdown
      new Notice(`Samaya: ${l.date} was not ended - closed at ${l.end}. Edit work_end in that daily note if needed.`, 8000);
    }
    this.log = null; await this.persist(); this.plugin.bus.emit();
  }

  private async persist() { this.plugin.data.workday = this.log; await this.plugin.saveData(this.plugin.data); }
  private async writeProps(l: DayLog) {
    const worked = workedOn(l, nowMin(), this.plugin.dayRules);
    const s = this.s; const patch: Record<string, string | number | boolean | string[] | null> = {};
    if (journalWants(s, "journalWorkTimes")) Object.assign(patch, { work_start: l.start, work_end: l.end, work_end_auto: l.endAuto ? true : null });
    if (journalWants(s, "journalBreaks")) Object.assign(patch, {
      lunch: `${minToHm(this.plugin.lunchFor(l.date)[0])}-${minToHm(this.plugin.lunchFor(l.date)[1])}`,
      breaks: l.breaks.map(fmtBreak), break_minutes: breakMinutes(l) || null,
    });
    if (journalWants(s, "journalTracked")) patch.work_minutes = l.end ? worked : null;
    if (!Object.keys(patch).length) return;
    await setJournalProps(this.plugin.app, s, l.date, { date: l.date, ...patch });
  }
  private async commit() { if (this.log) await this.writeProps(this.log); await this.persist(); this.plugin.bus.emit(); }

  async reopenDay() { const l = this.log; if (!l || !l.end) return; l.end = null; l.endAuto = false; await this.commit(); }
  async startDay(at = nowHm()) {
    if (this.started) return;
    if (this.log && this.log.date === today() && this.log.end) return this.reopenDay();
    this.log = { date: today(), start: at, end: null, breaks: [], open: null, seen: at };
    const fin = this.plugin.workWindowFor(today())[1]; // the timeline's start line follows the time the day was started
    if (hmToMin(at) < fin) await this.plugin.setWorkWindow(today(), [at, minToHm(fin)]);
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
    new Notice(`Workday ended at ${at} - worked ${fmtDur(workedOn(l, nowMin(), this.plugin.dayRules))}`);
  }
}
