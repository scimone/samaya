// The "This week" column of the week guide. It is the last column of the Weekly Board's guide.
import { Notice, TFile } from "obsidian";
import type SamayaPlugin from "../main";
import type { DndScope } from "../dnd";
import type { IcsEvent } from "../ics";
import { Task, createTask, patchTask, sortTasks } from "../model";
import { calendarEnabled, calendarEvents } from "../calendar";
import { addDays, fmtDur, parseTitleEstimate, parseYmd } from "../util";
import { Capacity, capacityWindow } from "../worktime";
import { bufferShare, loadLevel } from "../weekplan";
import { renderCapBar } from "./capBar";
import { renderTaskCard, bindZone } from "./common";

/** Everything that belongs to the week (done tasks included: they used up time), and the part without a day. */
export function weekBuckets(all: Task[], wk: string): { weekTasks: Task[]; noDay: Task[] } {
  const weekTasks = all.filter(t => (t.planned ? t.planned >= wk && t.planned < addDays(wk, 7) : t.week === wk));
  return { weekTasks, noDay: sortTasks(weekTasks.filter(t => !t.planned)) };
}

export function capacityOf(plugin: SamayaPlugin, date: string, events: IcsEvent[]): Capacity {
  const dayMs = parseYmd(date).getTime(); const end = parseYmd(addDays(date, 1)).getTime();
  return capacityWindow(...plugin.workWindowFor(date), plugin.lunchFor(date),
    events.filter(e => !e.allDay && e.end.getTime() > dayMs && e.start.getTime() < end).map((e): [number, number] => [(e.start.getTime() - dayMs) / 60000, (e.end.getTime() - dayMs) / 60000]));
}

/** Free minutes of the first `days` days of the week: work time - lunch - meetings. */
export async function weekFreeTime(plugin: SamayaPlugin, wk: string, days: number): Promise<number> { return (await weekCapacity(plugin, wk, days)).free; }
/** Free and meeting minutes of the first `days` days of the week. */
export async function weekCapacity(plugin: SamayaPlugin, wk: string, days: number): Promise<{ free: number; meetings: number }> {
  const s = plugin.settings;
  const events = calendarEnabled(s) ? await calendarEvents(plugin, parseYmd(wk), parseYmd(addDays(wk, 7))).catch(() => [] as IcsEvent[]) : [];
  const caps = Array.from({ length: days }, (_, i) => capacityOf(plugin, addDays(wk, i), events));
  return { free: caps.reduce((a, c) => a + c.free, 0), meetings: caps.reduce((a, c) => a + c.meetings, 0) };
}

/** "+ Add task" field: Enter creates the task with `props` (and the estimate typed after the title), then `done` runs once the note is indexed. */
export function addTaskInput(plugin: SamayaPlugin, host: HTMLElement, placeholder: string, props: () => Record<string, string | number>, done: () => void) {
  const s = plugin.settings;
  const add = host.createEl("input", { type: "text", cls: "samaya-add", attr: { placeholder } });
  add.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing || !add.value.trim()) return;
    const p = parseTitleEstimate(add.value); add.value = "";
    createTask(plugin.app, s, p.title, { ...props(), estimate: p.estimate ?? s.defaultEstimate })
      .then(() => { window.setTimeout(done, 250); })
      .catch((err: unknown) => { new Notice(`Samaya: could not create the task (${err instanceof Error ? err.message : String(err)})`); });
  });
  return add;
}

export interface WeekColumnOpts {
  step: number; wk: string; all: Task[]; /** free minutes of the week */ free: number; /** meeting minutes of the week */ meetings?: number; /** repaint after a task was added */ refresh: () => void;
  /** scroll position to keep, and a callback to remember it */ keepScroll?: number; onScroll?: (y: number) => void;
}
export const SCHEDULE_STEP = 3;

/** This week: heading with count, load bar with planned / recommended, the add field (not while scheduling) and the week's tasks. Dropping a task here takes its day away. */
export function renderWeekColumn(plugin: SamayaPlugin, scope: DndScope, host: HTMLElement, o: WeekColumnOpts) {
  const { wk } = o; const s = plugin.settings; const schedule = o.step === SCHEDULE_STEP;
  const { weekTasks, noDay } = weekBuckets(o.all, wk);
  const planned = weekTasks.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0);
  // Schedule: only what still needs a day; the other steps list everything, the weekday written on cards that have one
  const shown = schedule ? noDay : [...noDay, ...sortTasks(weekTasks.filter(t => t.planned)).sort((a, b) => a.planned.localeCompare(b.planned))];

  const col = host.createDiv("samaya-plancol samaya-wg-col samaya-wg-side");
  const h = col.createDiv("samaya-colhead"); h.createSpan({ cls: "samaya-colhead-title", text: "This week" }); h.createSpan({ cls: "samaya-colhead-count", text: String(shown.length) });
  const share = bufferShare(s.bufferPercent); const lvl = loadLevel(planned, o.free, share); const budget = Math.round(o.free * share);
  const box = col.createDiv({ cls: `samaya-loadbar is-${lvl}` });
  const meetings = o.meetings ?? 0;
  renderCapBar(box, { tasks: planned, meetings, free: o.free, share });
  const label = col.createDiv({ cls: "samaya-wg-info" }).createDiv({ cls: "samaya-total", text: `${fmtDur(planned + meetings)} allocated · ${fmtDur(meetings + budget)} recommended` });
  label.title = `Allocated = ${fmtDur(planned)} tasks + ${fmtDur(meetings)} meetings. Free time of the week = work time - lunch - meetings = ${fmtDur(o.free)}. Plan at most ${Math.round(share * 100)}% of it (${fmtDur(budget)}).`;
  if (!schedule) addTaskInput(plugin, col, "+ Add weekly task", () => ({ week: wk }), o.refresh); // before the first task (the days have their own in Schedule)
  const list = col.createDiv("samaya-wg-scroll samaya-leftover-list");
  if (!shown.length) list.createDiv({ cls: "samaya-empty", text: schedule ? "Every task has a day." : "Nothing planned for this week yet." });
  shown.forEach(t => renderTaskCard(plugin, list, t, { scope, dayLabel: t.planned ? parseYmd(t.planned).toLocaleDateString(undefined, { weekday: "long" }) : undefined }));
  list.scrollTop = o.keepScroll ?? 0; list.addEventListener("scroll", () => o.onScroll?.(list.scrollTop));
  bindZone(scope, col, path => { const f = plugin.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) void patchTask(plugin.app, f, { planned: null, start: null, week: wk }); });
}
