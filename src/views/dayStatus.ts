import { Notice, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import type { IcsEvent } from "../ics";
import { allTasks, sortTasks } from "../model";
import { fmtDur, parseYmd, startOfWeek, today } from "../util";
import { weekBuckets, weekFreeTime } from "./weekColumn";
import { renderGuide } from "./guide";
import { renderWorkdayCard } from "./workdayCard";
import { capacityWindow } from "../worktime";
import { bufferShare, loadLevel } from "../weekplan";
import { openPeriodNote } from "../journal";

/** The status column of the planner: workday, daily and weekly capacity; End day: the shutdown guide. */
export async function renderDayStatus(plugin: SamayaPlugin, host: HTMLElement, o: { date: string; events: IcsEvent[] }): Promise<void> {
  const { date, events } = o; const s = plugin.settings;
  const isToday = date === today();
  const guide = plugin.guide?.kind === "week" ? null : plugin.guide;
  if (isToday && guide?.kind === "shutdown") { renderGuide(plugin, host, { overdue: 0 }); return; }
  const all = allTasks(plugin.app, s);
  const day = sortTasks(all.filter(t => t.planned === date));
  const dayMs = parseYmd(date).getTime();
  const cap = capacityWindow(...plugin.workWindowFor(date), plugin.lunchFor(date),
    events.filter(e => !e.allDay).map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]));
  const plannedAll = day.reduce((a, t) => a + (t.estimate || 0), 0);
  const wkStart = startOfWeek(date);
  const weekPlanned = weekBuckets(all, wkStart).weekTasks.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0);
  const weekFree = guide ? 0 : await weekFreeTime(plugin, wkStart, s.workDays);
  if (!host.isConnected) return;
    renderWorkdayCard(plugin, host.createDiv("samaya-info-card"), { panel: true, date: date });

    // one card, two rows: today's and the week's load (planned time / recommended time, one bar each)
    const share = bufferShare(plugin.settings.bufferPercent); const pct = Math.round(share * 100);
    const card = host.createDiv("samaya-info-card samaya-info-load samaya-info-caps");
    const capRow = (label: string, planned: number, free: number, what: string): HTMLElement => {
      const over = planned > free; const lvl = loadLevel(planned, free, share);
      const row = card.createDiv({ cls: "samaya-cap-row" + (over ? " is-over" : "") });
      const top = row.createDiv("samaya-cap-top");
      top.createSpan({ cls: "samaya-info-label", text: label });
      const tot = top.createSpan({ cls: "samaya-info-big samaya-cap-fig", text: fmtDur(planned) });
      tot.createSpan({ cls: "samaya-info-rec", text: ` / ${fmtDur(Math.round(free * share))} recommended` });
      tot.title = `${what}. Plan at most ${pct}% of it (${fmtDur(Math.round(free * share))}) and keep the rest for what comes up.`;
      const bar = row.createDiv({ cls: `samaya-col-bar is-${lvl}` });
      bar.createDiv("samaya-col-bar-fill").style.width = `${over || free <= 0 ? (planned > 0 ? 100 : 0) : (planned / free) * 100}%`;
      if (free > 0) { const mark = bar.createDiv("samaya-col-bar-mark"); mark.style.left = `${share * 100}%`; mark.title = `${pct}% of the free time`; }
      return row.createDiv("samaya-cap-btns"); // the buttons of this row, under its bar
    };
    const dayBtns = capRow("Daily capacity", plannedAll, cap.free, `Free capacity = ${fmtDur(cap.total)} capacity - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`);
    if (isToday && !plugin.guide) dayBtns.createEl("button", { cls: "samaya-cap-btn", text: "Plan day" }).onclick = () => { void plugin.startGuide(); };
    const openNote = (p: "daily" | "weekly") => { void (async () => { await plugin.openJournalCalendar(); const f = await openPeriodNote(plugin.app, s, p, date); if (f) await plugin.openNoteInMain(f); else new Notice("Samaya: no journal location found for this note."); })(); }; // the journal calendar opens in the right sidebar, the note in front
    if (s.journalOn) dayBtns.createEl("button", { cls: "samaya-cap-btn", text: "Open daily note" }).onclick = () => openNote("daily");

    const weekBtns = capRow("Weekly capacity", weekPlanned, weekFree, "Free time of the week = work time - lunch - meetings");
    const curWeek = startOfWeek(date) === startOfWeek(today());
    if (curWeek && !plugin.guide) weekBtns.createEl("button", { cls: "samaya-cap-btn", text: "Plan week" }).onclick = () => { void plugin.startWeekGuide(); };
    if (curWeek) weekBtns.createEl("button", { cls: "samaya-cap-btn", text: "Review week", attr: { title: "Open this week's review: the weekly note, or the work time dashboard" } }).onclick = () => { void plugin.reviewWeek(); };
    if (s.journalOn && s.journalNotes.weekly.on) weekBtns.createEl("button", { cls: "samaya-cap-btn", text: "Open weekly note" }).onclick = () => openNote("weekly");
}
