import { Notice, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { allTasks } from "../model";
import { addDays, fmtDur, parseYmd, startOfWeek, today } from "../util";
import { calendarEnabled, calendarEvents } from "../calendar";
import { weekBuckets, weekCapacity } from "./weekColumn";
import { renderWorkdayCard } from "./workdayCard";
import { bufferShare } from "../weekplan";
import { renderCapBar } from "./capBar";
import { openPeriodNote } from "../journal";
import { vacationDates, weekAverageWorked } from "../worktime";

/** The planner heading's status and actions (day and week alike): `mid` gets the workday chip and a capacity meter, `actions` the buttons. */

/** A compact capacity meter: LABEL planned / recommended over a thin bar with the buffer mark. */
export function renderCapMeter(plugin: SamayaPlugin, host: HTMLElement, o: { label: string; planned: number; meetings: number; free: number; what: string }): HTMLElement {
  const share = bufferShare(plugin.settings.bufferPercent); const pct = Math.round(share * 100);
  const rec = Math.round(o.free * share); const over = o.planned > o.free;
  const m = host.createDiv({ cls: "samaya-hs-cap" + (over ? " is-over" : "") });
  m.title = `${o.what}.\nAllocated: ${fmtDur(o.planned)} tasks + ${fmtDur(o.meetings)} meetings.\nRecommended: at most ${pct}% of the free time for tasks (${fmtDur(rec)}) + the meetings, the rest stays open for what comes up.`;
  const top = m.createDiv("samaya-hs-cap-top"); // the label, then everything allocated (tasks + meetings) / everything recommended
  top.createSpan({ cls: "samaya-hs-cap-label", text: o.label });
  top.createSpan({ cls: "samaya-hs-cap-fig", text: fmtDur(o.planned + o.meetings) }).createSpan({ cls: "samaya-hs-cap-rec", text: ` / ${fmtDur(o.meetings + rec)}` });
  renderCapBar(m, { tasks: o.planned, meetings: o.meetings, free: o.free, share });
  return m;
}

/** Open the daily / weekly note in front, with the journal calendar in the right sidebar. */
function openNote(plugin: SamayaPlugin, p: "daily" | "weekly", date: string) {
  void (async () => {
    await plugin.openJournalCalendar();
    const f = await openPeriodNote(plugin.app, plugin.settings, p, date);
    if (f) await plugin.openNoteInMain(f); else new Notice("Samaya: no journal location found for this note.");
  })();
}

/** A view (a place to look at, not something to do): a quiet icon, never a button. */
const viewIcon = (host: HTMLElement, icon: string, label: string, run: () => void) => {
  const b = host.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": label } }); setIcon(b, icon); // aria-label shows Obsidian's tooltip; a title would show a second one b.onclick = run; return b;
};

const btn = (host: HTMLElement, text: string, run: () => void, title?: string) => { const b = host.createEl("button", { cls: "samaya-hd-btn", text, attr: title ? { title } : {} }); b.onclick = run; return b; };

/** The work time dashboard (in the Planner, with a button back), grouped with the status. */
const workTimeIcon = (plugin: SamayaPlugin, host: HTMLElement) => viewIcon(host, "bar-chart-2", "Work time dashboard", () => { void plugin.openDashboard(); });

/** Day heading: workday status, then the daily capacity grouped with Plan day; Break / End day (the workday's own buttons) and Daily note in the actions. */
export function renderDayHeadStatus(plugin: SamayaPlugin, mid: HTMLElement, right: HTMLElement, o: { date: string; planned: number; meetings: number; free: number; what: string }): void {
  const s = plugin.settings; const isToday = o.date === today();
  const sg = mid.createDiv("samaya-hs-group is-status");
  renderWorkdayCard(plugin, sg.createDiv("samaya-hs-wd"), { part: "status", date: o.date });
  workTimeIcon(plugin, sg);
  const group = mid.createDiv("samaya-hs-group is-cap");
  renderCapMeter(plugin, group, { label: "Capacity", planned: o.planned, meetings: o.meetings, free: o.free, what: o.what });
  if (isToday && !plugin.guide) btn(group, "Plan day", () => { void plugin.startGuide(); });
  const actions = right.createDiv("samaya-head-actions"); // things to do: buttons
  if (isToday) renderWorkdayCard(plugin, actions.createDiv("samaya-hs-wd-actions"), { part: "actions" });

}

/** Week heading: the status chip (this week: today's status; a past week: the average work time per working day; a coming week: none), then the weekly capacity (live: it follows the tasks) grouped with Plan week; Review week and Weekly note in the actions. */
export function renderWeekHeadStatus(plugin: SamayaPlugin, mid: HTMLElement, right: HTMLElement, weekStart: string): void {
  const s = plugin.settings; const thisWeek = startOfWeek(today()); const cur = weekStart === thisWeek;
  const sg = mid.createDiv("samaya-hs-group is-status");
  const chip = sg.createDiv("samaya-hs-wd");
  workTimeIcon(plugin, sg);
  if (weekStart > thisWeek) { const c = chip.createDiv({ cls: "samaya-wd samaya-wd-chip", attr: { title: "Nothing to track yet: this week has not started." } }); c.createSpan({ cls: "samaya-wd-state", text: "Not started yet" }); }
  else if (cur) renderWorkdayCard(plugin, chip, { part: "status" });
  else if (weekStart < thisWeek) void (async () => {
    const events = calendarEnabled(s) ? await calendarEvents(plugin, parseYmd(weekStart), parseYmd(addDays(weekStart, 7))).catch(() => []) : [];
    if (!chip.isConnected) return;
    renderWorkdayCard(plugin, chip, { part: "status", average: weekAverageWorked(plugin.workday.allLogs(), weekStart, s.workDays, vacationDates(events, s.vacationKeyword)) });
  })();
  const group = mid.createDiv("samaya-hs-group is-cap");
  const slot = group.createDiv("samaya-hs-slot"); let token = 0; let timer = 0;
  const paint = async () => {
    if (!slot.isConnected) { off(); metaOff(); window.clearTimeout(timer); return; }
    const my = ++token;
    const planned = weekBuckets(allTasks(plugin.app, s), weekStart).weekTasks.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0);
    const { free, meetings } = await weekCapacity(plugin, weekStart, s.workDays);
    if (my !== token || !slot.isConnected) return;
    slot.empty(); renderCapMeter(plugin, slot, { label: "Capacity", planned, meetings, free, what: "Free time of the week = work time - lunch - meetings" });
  };
  const later = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void paint(); }, 200); };
  const off = plugin.bus.on(later);
  const ref = plugin.app.metadataCache.on("changed", later); const metaOff = () => plugin.app.metadataCache.offref(ref);
  void paint();
  if (cur && !plugin.guide) btn(group, "Plan week", () => { void plugin.startWeekGuide(); });
  const actions = right.createDiv("samaya-head-actions");
  if (cur) btn(actions, "Review week", () => { void plugin.reviewWeek(); }, "Open this week's review: the weekly note, or the work time dashboard");

}

/** The note icons (a view, so an icon): right of the Today / This week pill, left of the date navigation, always in the same place. */
export function renderDayNoteIcon(plugin: SamayaPlugin, right: HTMLElement, date: string): void {
  if (plugin.settings.journalOn) viewIcon(right, "file-text", "Daily note", () => openNote(plugin, "daily", date));
}
export function renderWeekNoteIcon(plugin: SamayaPlugin, right: HTMLElement, weekStart: string): void {
  if (plugin.settings.journalOn && plugin.settings.journalNotes.weekly.on) viewIcon(right, "file-text", "Weekly note", () => openNote(plugin, "weekly", weekStart));
}
