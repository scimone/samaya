import { addDays, parseYmd, startOfWeek, today } from "../util";
import { renderDateNav, renderResetPill } from "./dateNav";

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

/** The week heading: "Week 46", then [This week pill] ‹ Nov 9 – 15 › (the label opens a date picker: pick any day to jump to its week) and Day | Week. */
export function renderWeekHead(head: HTMLElement, weekStart: string, go: (weekStart: string) => void, back?: () => void): void {
  const cur = startOfWeek(today());
  head.createEl("h2", { cls: "samaya-planner-title", text: `Week ${isoWeek(parseYmd(weekStart))}` });
  const right = head.createDiv("samaya-planner-right"); // same spot as the day heading's controls: navigation, then the Day | Week switch
  if (weekStart !== cur) renderResetPill(right, "This week", "Back to the current week", weekStart < cur ? "right" : "left", () => go(cur)); // only when you are somewhere else
  renderDateNav(right, {
    label: weekRangeLabel(weekStart), prevLabel: "Previous week", nextLabel: "Next week",
    onPrev: () => go(addDays(weekStart, -7)), onNext: () => go(addDays(weekStart, 7)),
    pick: { value: weekStart, label: "Pick a week", run: d => go(startOfWeek(d)) },
  });
  if (back) renderModeSwitch(right, "week", { day: back });
}
