import { setIcon } from "obsidian";
import { safe } from "../safe";
import type SamayaPlugin from "../main";
import { richText } from "./common";
import { weekSteps } from "./../weekplan";

export const GUIDE_STEPS = [
  { title: "Overdue tasks", text: "Review unfinished tasks from earlier days: move them to `Today`, `Tomorrow` or `This week`, back to the `Backlog`, or mark them done." },
  { title: "Pick", text: "Choose what you want to do today from `This week` or `Backlog`: press `Today` on a card, or drag it into the list. You can also add new tasks here, or drag a planned task back to `This week` or `Backlog` to swap it out." },
  { title: "Timebox", text: "Drag your tasks onto the timeline to give them a time slot. Move the start and finish lines to set your day, then press `Next`." },
  { title: "Check", text: "Look at the whole day: is it too full, does every task have a time slot? Fix it with the `Back` button, then press `{done}`." },
];

export const WEEK_GUIDE_STEPS = [
  { title: "Overdue tasks", text: "Review unfinished tasks from earlier days and weeks: move them to `This week`, back to the `Backlog`, or mark them done." },
  { title: "Tickets", text: "Your open tickets, one row per project. Press `New task` on a ticket to plan work for it. New tasks for this week appear in `This week` on the right." },
  { title: "Backlog", text: "Pull what belongs into the week: press `This week` on a backlog card, or drag it across. Add anything new that is on your mind, and drag tasks you will not get to back to the `Backlog`." },
  { title: "Schedule", text: "Drag the week's tasks onto the days. Each day shows its meetings on top and how full it is. Tasks without a day stay in the list on the left." },
  { title: "Check", text: "Look at the whole week: is any day too full, is anything still without a day? Fix it with the `Back` button, then press `{done}`." },
];
/** The buffer reminder under every step of the day and week guides. */
export function bufferReminder(bufferPercent: number): string {
  return `Don't plan 100% of your day. Unforeseen meetings, calls, emergencies and tasks will cross your way: keep about ${Math.round(bufferPercent)}% of your free time open.`;
}
function addReminder(plugin: SamayaPlugin, box: HTMLElement) {
  const rem = box.createDiv("samaya-plan-reminder");
  setIcon(rem.createSpan("samaya-plan-reminder-icon"), "life-buoy");
  rem.createSpan({ text: bufferReminder(plugin.settings.bufferPercent) });
}

export interface GuideCtx { overdue: number; /** Timebox: how many of today's tasks still lack a time slot, and how many there are */ toSchedule?: number; planned?: number; }

interface StepperCfg {
  kicker: string; cancelLabel: string; steps: ReadonlyArray<{ title: string; text: string }>;
  /** indices of `steps` that are shown (the Review step only exists when something is overdue ...) */
  visible: number[]; doneLabel: string; finish: () => void; reminder: boolean;
  /** extra content under the instructions of the active step */
  extra?: (i: number, main: HTMLElement) => void;
}
const overdueAlert = (main: HTMLElement, n: number) =>
  main.createDiv({ cls: "samaya-plan-alert" + (n ? "" : " is-clear"), text: n ? `There ${n === 1 ? "is 1 overdue task" : `are ${n} overdue tasks`} to review.` : "All overdue tasks have been handled." });

/** The vertical stepper of the day, week and end-of-day guides: finished steps tick off, the current one opens with its instructions, Back / Next underneath. */
function renderStepper(plugin: SamayaPlugin, host: HTMLElement, cfg: StepperCfg) {
  const g = plugin.guide!; const vis = cfg.visible; const pos = vis.indexOf(g.step);
  const go = (to: number) => { g.step = to; plugin.bus.emit(); };
  const box = host.createDiv("samaya-plan");
  const top = box.createDiv("samaya-plan-top");
  top.createSpan({ cls: "samaya-plan-kicker", text: cfg.kicker });
  const x = top.createEl("button", { cls: "samaya-plan-cancel clickable-icon", attr: { "aria-label": cfg.cancelLabel } });
  setIcon(x, "x"); x.onclick = () => plugin.cancelGuide();

  const list = box.createEl("ol", { cls: "samaya-plan-steps" });
  cfg.steps.forEach((st, i) => {
    if (!vis.includes(i)) return;
    const li = list.createEl("li", { cls: `samaya-plan-step ${i === g.step ? "is-active" : i < g.step ? "is-done" : "is-todo"}` });
    const marker = li.createDiv("samaya-plan-marker");
    if (i < g.step) setIcon(marker, "check"); else marker.setText(String(vis.indexOf(i) + 1));
    const main = li.createDiv("samaya-plan-main");
    main.createDiv("samaya-plan-title").createSpan({ text: st.title });
    if (i < g.step) { li.addClass("is-link"); li.onclick = () => go(i); li.setAttr("title", `Back to ${st.title}`); }
    if (i === g.step) { richText(main.createDiv("samaya-plan-text"), st.text.replace("{done}", cfg.doneLabel)); cfg.extra?.(i, main); }
  });

  const nav = box.createDiv("samaya-plan-nav");
  if (pos > 0) nav.createEl("button", { text: "Back", cls: "samaya-plan-back" }).onclick = () => go(vis[pos - 1]);
  const last = pos === vis.length - 1;
  nav.createEl("button", { text: last ? cfg.doneLabel : "Next", cls: "mod-cta samaya-plan-next" }).onclick = () => { if (last) cfg.finish(); else go(vis[pos + 1]); };
  if (cfg.reminder) addReminder(plugin, box);
}
const range = (from: number, n: number) => Array.from({ length: n - from }, (_, i) => from + i);

/** Interactive "plan my day" guide (see renderStepper). The Review step only exists when something is overdue. */
export function renderGuide(plugin: SamayaPlugin, host: HTMLElement, ctx: GuideCtx) {
  const g = plugin.guide; if (!g) return;
  if (g.kind === "shutdown") return renderShutdownGuide(plugin, host);
  if (g.kind === "week") return renderWeekGuide(plugin, host, ctx);
  renderStepper(plugin, host, {
    kicker: "Plan my day", cancelLabel: "Cancel planning", steps: GUIDE_STEPS, visible: range(g.review ? 0 : 1, GUIDE_STEPS.length),
    doneLabel: plugin.workday.started ? "Finalize plan" : "Start my day", finish: () => safe(plugin.finishGuide(), "finishing the plan"), reminder: true,
    extra: (i, main) => {
      if (i === 0) overdueAlert(main, ctx.overdue);
      if (i === 2 && ctx.planned) { const n = ctx.toSchedule ?? 0; main.createDiv({ cls: "samaya-plan-alert" + (n ? "" : " is-clear"), text: n ? `There ${n === 1 ? "is 1 task" : `are ${n} tasks`} to schedule.` : "All tasks have been scheduled." }); }
    },
  });
}

export const SHUTDOWN_STEPS = [
  { title: "Check off finished tasks", text: "Did you finish something and forget to tick it off? Check off any finished tasks in the list. Then press `Next`." },
  { title: "Review your day", text: "See how you spent your time and how it compares with your plan. Then press `End my day`." },
];

/** End of day, two steps: tick off forgotten tasks, then look back at how the day went (see views/dayReview.ts) and finalize. */
function renderShutdownGuide(plugin: SamayaPlugin, host: HTMLElement) {
  renderStepper(plugin, host, { kicker: "End my day", cancelLabel: "Cancel", steps: SHUTDOWN_STEPS, visible: range(0, SHUTDOWN_STEPS.length), doneLabel: "End my day", finish: () => safe(plugin.finishShutdown(), "ending the day"), reminder: false });
}

/** "Plan my week": same stepper as the day guide, with the reminder to leave room for the unexpected under every step. */
function renderWeekGuide(plugin: SamayaPlugin, host: HTMLElement, ctx: GuideCtx) {
  const g = plugin.guide!;
  renderStepper(plugin, host, {
    kicker: "Plan my week", cancelLabel: "Cancel planning", steps: WEEK_GUIDE_STEPS, visible: weekSteps(g.review, !!g.tickets), doneLabel: "Finish week plan",
    finish: () => safe(plugin.finishWeekGuide(), "finishing the week plan"), reminder: true, extra: (i, main) => { if (i === 0) overdueAlert(main, ctx.overdue); },
  });
}
