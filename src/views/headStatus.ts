import { Notice } from "obsidian";
import type SamayaPlugin from "../main";
import { allTasks } from "../model";
import { fmtDur, startOfWeek, today } from "../util";
import { weekBuckets, weekFreeTime } from "./weekColumn";
import { renderWorkdayCard } from "./workdayCard";
import { bufferShare, loadLevel } from "../weekplan";
import { openPeriodNote } from "../journal";

/** The planner heading's status and actions (day and week alike): `mid` gets the workday chip and a capacity meter, `actions` the buttons. */

/** A compact capacity meter: LABEL planned / recommended over a thin bar with the buffer mark. */
export function renderCapMeter(plugin: SamayaPlugin, host: HTMLElement, o: { label: string; planned: number; free: number; what: string }): HTMLElement {
  const share = bufferShare(plugin.settings.bufferPercent); const pct = Math.round(share * 100);
  const rec = Math.round(o.free * share); const lvl = loadLevel(o.planned, o.free, share); const over = o.planned > o.free;
  const m = host.createDiv({ cls: "samaya-hs-cap" + (over ? " is-over" : "") });
  m.title = `${o.what}. Plan at most ${pct}% of it (${fmtDur(rec)}) and keep the rest for what comes up.`;
  const top = m.createDiv("samaya-hs-cap-top");
  top.createSpan({ cls: "samaya-hs-cap-label", text: o.label });
  const fig = top.createSpan({ cls: "samaya-hs-cap-fig", text: fmtDur(o.planned) });
  fig.createSpan({ cls: "samaya-hs-cap-rec", text: ` / ${fmtDur(rec)}` });
  const bar = m.createDiv({ cls: `samaya-hs-bar is-${lvl}` });
  bar.createDiv("samaya-hs-bar-fill").style.width = `${over || o.free <= 0 ? (o.planned > 0 ? 100 : 0) : (o.planned / o.free) * 100}%`;
  if (o.free > 0) bar.createDiv("samaya-hs-bar-mark").style.left = `${share * 100}%`;
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

const btn = (host: HTMLElement, text: string, run: () => void, title?: string) => { const b = host.createEl("button", { cls: "samaya-hd-btn", text, attr: title ? { title } : {} }); b.onclick = run; return b; };

/** Day heading: workday status + daily capacity; Plan day, Break / End day (the workday's own buttons) and Daily note. */
export function renderDayHeadStatus(plugin: SamayaPlugin, mid: HTMLElement, actions: HTMLElement, o: { date: string; planned: number; free: number; what: string }): void {
  const s = plugin.settings; const isToday = o.date === today();
  renderWorkdayCard(plugin, mid.createDiv("samaya-hs-wd"), { part: "status", date: o.date });
  renderCapMeter(plugin, mid, { label: "Daily", planned: o.planned, free: o.free, what: o.what });
  if (isToday && !plugin.guide) btn(actions, "Plan day", () => { void plugin.startGuide(); });
  if (isToday) renderWorkdayCard(plugin, actions.createDiv("samaya-hs-wd-actions"), { part: "actions" });
  if (s.journalOn) btn(actions, "Daily note", () => openNote(plugin, "daily", o.date), "Open this day's note");
}

/** Week heading: workday status + weekly capacity (live: it follows the tasks); Plan week, Review week and Weekly note. */
export function renderWeekHeadStatus(plugin: SamayaPlugin, mid: HTMLElement, actions: HTMLElement, weekStart: string): void {
  const s = plugin.settings; const cur = weekStart === startOfWeek(today());
  renderWorkdayCard(plugin, mid.createDiv("samaya-hs-wd"), { part: "status" });
  const slot = mid.createDiv("samaya-hs-slot"); let token = 0; let timer = 0;
  const paint = async () => {
    if (!slot.isConnected) { off(); metaOff(); window.clearTimeout(timer); return; }
    const my = ++token;
    const planned = weekBuckets(allTasks(plugin.app, s), weekStart).weekTasks.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0);
    const free = await weekFreeTime(plugin, weekStart, s.workDays);
    if (my !== token || !slot.isConnected) return;
    slot.empty(); renderCapMeter(plugin, slot, { label: "Weekly", planned, free, what: "Free time of the week = work time - lunch - meetings" });
  };
  const later = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void paint(); }, 200); };
  const off = plugin.bus.on(later);
  const ref = plugin.app.metadataCache.on("changed", later); const metaOff = () => plugin.app.metadataCache.offref(ref);
  void paint();
  if (cur && !plugin.guide) btn(actions, "Plan week", () => { void plugin.startWeekGuide(); });
  if (cur) btn(actions, "Review week", () => { void plugin.reviewWeek(); }, "Open this week's review: the weekly note, or the work time dashboard");
  if (s.journalOn && s.journalNotes.weekly.on) btn(actions, "Weekly note", () => openNote(plugin, "weekly", weekStart), "Open this week's note");
}
