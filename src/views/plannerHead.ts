import { addDays, parseYmd, startOfWeek, today } from "../util";
import type SamayaPlugin from "../main";
import { renderDateNav, renderResetPill } from "./dateNav";
import { renderWeekHeadStatus } from "./headStatus";

/** ISO week number of a date (weeks start on Monday). */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

/** "Nov 9 – 15" / "Oct 26 – Nov 1" (+ the year when it is not the current one). */
export function weekRangeLabel(weekStart: string): string {
  const a = parseYmd(weekStart), z = parseYmd(addDays(weekStart, 6)); const mon = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  const range = a.getMonth() === z.getMonth() ? `${mon(a)} ${a.getDate()} – ${z.getDate()}` : `${mon(a)} ${a.getDate()} – ${mon(z)} ${z.getDate()}`;
  return range + (a.getFullYear() !== new Date().getFullYear() ? `, ${a.getFullYear()}` : "");
}

/** The heading's title with its muted line underneath (the date and week), the same in the day and the week heading. */
export function renderHeadTitle(head: HTMLElement, title: string, sub: string): HTMLElement {
  const box = head.createDiv("samaya-planner-titles");
  box.createEl("h2", { cls: "samaya-planner-title", text: title });
  box.createDiv({ cls: "samaya-planner-sub", text: sub });
  return box;
}

/** "Thursday, Nov 12 · Week 46" for today, "Nov 13 · Week 46" for another day (+ the year when it is not the current one). */
export function dayHeadSub(date: string): string {
  const d = parseYmd(date); const year = d.getFullYear() !== new Date().getFullYear();
  const text = d.toLocaleDateString(undefined, { weekday: date === today() ? "long" : undefined, month: "short", day: "numeric", year: year ? "numeric" : undefined });
  return `${text} · Week ${isoWeek(d)}`;
}

/** The Day | Week switch, the same control in the day heading, the week heading and the standalone week views. Clicking the active side does nothing. */
export function renderModeSwitch(parent: HTMLElement, active: "day" | "week", go: { day?: () => void; week?: () => void }): HTMLElement {
  const sw = parent.createDiv("samaya-modeswitch"); sw.setAttr("role", "group"); sw.setAttr("aria-label", "Planner view");
  const side = (key: "day" | "week", text: string, hint: string) => {
    const on = active === key;
    const b = sw.createEl("button", { text, cls: on ? "is-active" : "", attr: { title: on ? text : hint, "aria-pressed": String(on) } });
    if (!on && go[key]) b.onclick = go[key]!;
  };
  side("day", "Day", "Back to the day planner (Esc)");
  side("week", "Week", "Expand to the week timeline");
  return sw;
}

/** Fit the heading into one line: while it overflows, step `data-fit` up (CSS drops the less important parts one by one: wider labels, then texts, then groups). Re-checked whenever the heading resizes. */
const fitters = new WeakMap<HTMLElement, ResizeObserver>();
export function fitHead(head: HTMLElement): void {
  const run = () => {
    if (!head.isConnected || !head.clientWidth) return;
    let lvl = 0; head.dataset.fit = "0";
    while (head.scrollWidth > head.clientWidth + 1 && lvl < 5) head.dataset.fit = String(++lvl);
  };
  fitters.get(head)?.disconnect(); const ro = new ResizeObserver(run); fitters.set(head, ro); ro.observe(head); window.requestAnimationFrame(run);
}

/** The week heading: "Week 46" over its date range, the workday status and weekly capacity, then the actions (Plan week, Review week, Weekly note), [This week pill] ‹ 📅 › (the calendar button opens a date picker: pick any day to jump to its week) and Day | Week. */
export function renderWeekHead(head: HTMLElement, weekStart: string, go: (weekStart: string) => void, back?: () => void, plugin?: SamayaPlugin): void {
  const cur = startOfWeek(today());
  renderHeadTitle(head, `Week ${isoWeek(parseYmd(weekStart))}`, weekRangeLabel(weekStart) + (weekStart === cur ? " · This week" : ""));
  const mid = plugin ? head.createDiv("samaya-head-mid") : null; // workday status and weekly capacity (a pane hidden behind the planner's own heading skips them)
  const right = head.createDiv("samaya-planner-right"); // same spot as the day heading's controls: actions, navigation, then the Day | Week switch
  if (plugin && mid) renderWeekHeadStatus(plugin, mid, right, weekStart);
  if (weekStart !== cur) renderResetPill(right, "This week", "Back to the current week", weekStart < cur ? "right" : "left", () => go(cur)); // only when you are somewhere else
  renderDateNav(right, {
    label: weekRangeLabel(weekStart), prevLabel: "Previous week", nextLabel: "Next week",
    onPrev: () => go(addDays(weekStart, -7)), onNext: () => go(addDays(weekStart, 7)),
    pick: { value: weekStart, label: "Pick a week", run: d => go(startOfWeek(d)) }, icon: "calendar",
  });
  if (back) renderModeSwitch(right, "week", { day: back });
  if (plugin) fitHead(head);
}
