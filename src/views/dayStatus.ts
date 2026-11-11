import { Notice, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import type { IcsEvent } from "../ics";
import { allTasks, sortTasks } from "../model";
import { addDays, fmtDur, parseYmd, startOfWeek, today } from "../util";
import { weekBuckets, weekFreeTime } from "./weekColumn";
import { renderGuide } from "./guide";
import { renderDateNav, renderResetPill } from "./dateNav";
import { renderWorkdayCard } from "./workdayCard";
import { capacityWindow } from "../worktime";
import { bufferShare, loadLevel } from "../weekplan";
import { openPeriodNote } from "../journal";

/** The status column of the planner (lives in the right sidebar): day title and navigation, workday, daily and weekly capacity; End day: the shutdown guide. */
export async function renderDayStatus(plugin: SamayaPlugin, host: HTMLElement, o: { date: string; events: IcsEvent[]; go: (date: string) => void; /** false = in the planner's own column: no date navigation, no "Open day" */ nav?: boolean }): Promise<void> {
  const { date, events, go } = o; const s = plugin.settings;
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
    const d = parseYmd(date);
    // day column: title + navigation, workday status, capacity, plan button
    if (o.nav !== false) {
      const hero = host.createDiv("samaya-info-hero");
      const titles = hero.createDiv("samaya-info-titles");
      const top = titles.createDiv("samaya-info-titlerow");
      top.createEl("h2", { text: isToday ? "Today" : d.toLocaleDateString(undefined, { weekday: "long" }) }); // the sidebar on other pages: Today shortcut, then ‹ date ›. In the planner the navigation sits in the timeline header instead.
      const side = top.createDiv("samaya-planner-right");
      if (!isToday) renderResetPill(side, "Today", "Jump to today", date < today() ? "right" : "left", () => go(today()));
      renderDateNav(side, {
        label: d.toLocaleDateString(undefined, { weekday: isToday ? "short" : undefined, month: "short", day: "numeric" }),
        prevLabel: "Previous day", nextLabel: "Next day", onPrev: () => go(addDays(date, -1)), onNext: () => go(addDays(date, 1)),
        pick: { value: date, label: "Pick a day", run: go },
      });
    } // in the planner the title bar above the columns says which day it is

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
    if (o.nav !== false) dayBtns.createEl("button", { cls: "samaya-cap-btn", text: "Open day" }).onclick = () => { void plugin.openPlanner().then(() => plugin.plannerGoTo?.(date)); };
    if (isToday && !plugin.guide) dayBtns.createEl("button", { cls: "samaya-cap-btn", text: "Plan day" }).onclick = () => { void plugin.startGuide(); };
    const openNote = (p: "daily" | "weekly") => { void openPeriodNote(plugin.app, s, p, date).then(f => { if (f) return plugin.openNoteInMain(f); new Notice("Samaya: no journal location found for this note."); }); };
    if (s.journalOn) dayBtns.createEl("button", { cls: "samaya-cap-btn", text: "Open daily note" }).onclick = () => openNote("daily");

    const weekBtns = capRow("Weekly capacity", weekPlanned, weekFree, "Free time of the week = work time - lunch - meetings");
    if (o.nav !== false) weekBtns.createEl("button", { cls: "samaya-cap-btn", text: "Open week" }).onclick = () => { void plugin.openPlanner().then(() => plugin.expandTimeline()); }; // in the planner itself the Day | Week switch does this
    const curWeek = startOfWeek(date) === startOfWeek(today());
    if (curWeek && !plugin.guide) weekBtns.createEl("button", { cls: "samaya-cap-btn", text: "Plan week" }).onclick = () => { void plugin.startWeekGuide(); };
    if (curWeek) weekBtns.createEl("button", { cls: "samaya-cap-btn", text: "Review week", attr: { title: "Open this week's review: the weekly note, or the work time dashboard" } }).onclick = () => { void plugin.reviewWeek(); };
    if (s.journalOn && s.journalNotes.weekly.on) weekBtns.createEl("button", { cls: "samaya-cap-btn", text: "Open weekly note" }).onclick = () => openNote("weekly");
}
