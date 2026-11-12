import { TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { dayTask, readTask } from "../model";
import { addDays, fmtHm, minToHm, parseYmd, today } from "../util";
import { focusButton, trackedBefore } from "./place";

const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
/** "Thu, 12 Nov" (Today / Tomorrow for those). */
function dayLabel(date: string): string {
  const t = today();
  if (date === t) return "Today";
  if (date === addDays(t, 1)) return "Tomorrow";
  return DAY_FMT.format(parseYmd(date));
}

/** The card above a task note: status, planned sessions, tracked / estimated time (all days, and today when that differs) and a Focus button. Replaces the properties block. */
export function renderTaskCard(plugin: SamayaPlugin, el: HTMLElement, file: TFile | null) {
  const cards = () => Array.from(el.querySelectorAll<HTMLElement>(":scope > .samaya-task-card"));
  if (!file) { cards().forEach(c => c.remove()); return; }
  const t = readTask(plugin.app, file);
  const day = today(); const dt = dayTask(t, day); const hasToday = t.sessions.some(g => g.date === day);
  const todayEst = hasToday ? dt.estimate : 0;
  const todayAct = Math.max(0, t.actual - trackedBefore(plugin, t, day));
  const showToday = hasToday ? (todayEst !== t.estimate || todayAct !== t.actual) : false;
  const f = plugin.focus.state;
  const key = JSON.stringify([file.path, t.status, t.sessions, t.estimate, t.actual, todayEst, todayAct, showToday, f ? [f.path, !!f.startedAt] : null, day]);
  const existing = cards();
  if (existing.length === 1 && existing[0].dataset.key === key) return;
  existing.forEach(c => c.remove());
  const content = el.querySelector(":scope > .view-content"); if (!content) return;
  const card = createDiv({ cls: "samaya-task-card" }); card.dataset.key = key;

  const head = card.createDiv("samaya-tc-head");
  const done = t.status === "done";
  const status = head.createSpan({ cls: "samaya-tc-status" + (done ? " is-done" : "") });
  setIcon(status.createSpan({ cls: "samaya-tc-icon" }), done ? "circle-check" : "circle");
  status.createSpan({ text: done ? "Done" : "To do" });
  const time = head.createDiv("samaya-tc-times");
  const stat = (label: string, base: number, est: number) => {
    const s = time.createDiv("samaya-tc-stat"); s.createSpan({ cls: "samaya-tc-label", text: label });
    const v = s.createSpan({ cls: "samaya-tc-val" });
    const act = v.createSpan({ cls: "samaya-tc-act", text: fmtHm(base + (f?.path === file.path ? plugin.focus.liveMin(file.path) : 0)) });
    if (f?.path === file.path) { act.dataset.tcBase = String(base); }
    v.createSpan({ cls: "samaya-tc-sep", text: " / " });
    v.createSpan({ cls: "samaya-tc-est", text: est ? fmtHm(est) : "--:--" });
  };
  stat("All days", t.actual, t.estimate);
  if (showToday) stat("Today", todayAct, todayEst);
  if (!done) { const b = focusButton(plugin, head, t, "samaya-tc-focus"); if (b) b.addClass("mod-cta"); }

  if (t.sessions.length) {
    const list = card.createDiv("samaya-tc-sessions");
    list.createSpan({ cls: "samaya-tc-label", text: "Planned" });
    for (const g of t.sessions) {
      const chip = list.createSpan({ cls: "samaya-tc-session" + (g.date === day ? " is-today" : g.date < day ? " is-past" : "") });
      chip.createSpan({ cls: "samaya-tc-day", text: dayLabel(g.date) });
      chip.createSpan({ cls: "samaya-tc-when", text: g.s !== null ? `${minToHm(g.s)}–${minToHm(g.s + g.dur)}` : g.dur ? fmtHm(g.dur) : "" });
    }
  }
  el.insertBefore(card, content);
}
