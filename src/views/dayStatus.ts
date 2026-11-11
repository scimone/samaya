import { setIcon } from "obsidian";
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

/** The status column of the planner (lives in the right sidebar): day title and navigation, workday, daily and weekly capacity; End day: the shutdown guide. */
export async function renderDayStatus(plugin: SamayaPlugin, host: HTMLElement, o: { date: string; events: IcsEvent[]; go: (date: string) => void }): Promise<void> {
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
    const hero = host.createDiv("samaya-info-hero");
    const titles = hero.createDiv("samaya-info-titles");
    const top = titles.createDiv("samaya-info-titlerow");
    top.createEl("h2", { text: isToday ? "Today" : d.toLocaleDateString(undefined, { weekday: "long" }) });
    const side = top.createDiv("samaya-info-side"); // Today shortcut, then ‹ date › (same design as the week heading)
    if (!isToday) renderResetPill(side, "Today", "Jump to today", date < today() ? "right" : "left", () => go(today()));
    renderDateNav(side, {
      label: d.toLocaleDateString(undefined, { weekday: isToday ? "short" : undefined, month: "short", day: "numeric" }),
      prevLabel: "Previous day", nextLabel: "Next day", onPrev: () => go(addDays(date, -1)), onNext: () => go(addDays(date, 1)),
      pick: { value: date, run: go },
    });

    renderWorkdayCard(plugin, host.createDiv("samaya-info-card"), { panel: true, date: date });

    const over = plannedAll > cap.free; const share = bufferShare(plugin.settings.bufferPercent); const lvl = loadLevel(plannedAll, cap.free, share);
    const load = host.createDiv({ cls: "samaya-info-card samaya-info-load" + (over ? " is-over" : "") });
    load.createDiv({ cls: "samaya-info-label", text: "Daily capacity" });
    const tot = load.createDiv({ cls: "samaya-info-big", text: fmtDur(plannedAll) });
    tot.createSpan({ cls: "samaya-info-rec", text: ` / ${fmtDur(Math.round(cap.free * share))} recommended` });
    tot.title = `Free capacity = ${fmtDur(cap.total)} capacity - ${fmtDur(cap.lunch)} lunch - ${fmtDur(cap.meetings)} meetings`;
    tot.title += `. Plan at most ${Math.round(share * 100)}% of it (${fmtDur(Math.round(cap.free * share))}) and keep the rest for what comes up.`;
    const bar = load.createDiv({ cls: `samaya-col-bar is-${lvl}` });
    bar.createDiv("samaya-col-bar-fill").style.width = `${over || cap.free <= 0 ? (plannedAll > 0 ? 100 : 0) : (plannedAll / cap.free) * 100}%`;
    if (cap.free > 0) { const mark = bar.createDiv("samaya-col-bar-mark"); mark.style.left = `${share * 100}%`; mark.title = `${Math.round(share * 100)}% of the free time`; }
    const row = load.createDiv("samaya-wd-buttons");
    row.createEl("button", { text: "Open day" }).onclick = () => { void plugin.openPlanner().then(() => plugin.plannerGoTo?.(date)); };
    if (isToday && !plugin.guide) row.createEl("button", { text: "Plan day" }).onclick = () => { void plugin.startGuide(); };

    const wLvl = loadLevel(weekPlanned, weekFree, share); const wOver = weekPlanned > weekFree;
    const wk = host.createDiv({ cls: "samaya-info-card samaya-info-load" + (wOver ? " is-over" : "") });
    wk.createDiv({ cls: "samaya-info-label", text: "Weekly capacity" });
    const wtot = wk.createDiv({ cls: "samaya-info-big", text: fmtDur(weekPlanned) });
    wtot.createSpan({ cls: "samaya-info-rec", text: ` / ${fmtDur(Math.round(weekFree * share))} recommended` });
    wtot.title = `Free time of the week = work time - lunch - meetings. Plan at most ${Math.round(share * 100)}% of it (${fmtDur(Math.round(weekFree * share))}) and keep the rest for what comes up.`;
    const wbar = wk.createDiv({ cls: `samaya-col-bar is-${wLvl}` });
    wbar.createDiv("samaya-col-bar-fill").style.width = `${wOver || weekFree <= 0 ? (weekPlanned > 0 ? 100 : 0) : (weekPlanned / weekFree) * 100}%`;
    if (weekFree > 0) { const mark = wbar.createDiv("samaya-col-bar-mark"); mark.style.left = `${share * 100}%`; mark.title = `${Math.round(share * 100)}% of the free time`; }
    const wrow = wk.createDiv("samaya-wd-buttons");
    wrow.createEl("button", { text: "Open week" }).onclick = () => { void plugin.openPlanner().then(() => plugin.expandTimeline()); };
    if (startOfWeek(date) === startOfWeek(today()) && !plugin.guide) wrow.createEl("button", { text: "Plan week" }).onclick = () => { void plugin.startWeekGuide(); };
}
