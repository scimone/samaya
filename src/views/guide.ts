import { setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { richText } from "./common";
import { weekSteps } from "./../weekplan";

export const GUIDE_STEPS = [
  { title: "Review", text: "Unfinished tasks from earlier days: move them to `Today`, `Tomorrow` or `This week`, back to the `Backlog`, or mark them done." },
  { title: "Pick", text: "Choose what you want to do today from `This week` or `Backlog`: press `Today` on a card, or drag it into the list. You can also add new tasks here, or drag a planned task back to `This week` or `Backlog` to swap it out." },
  { title: "Timebox", text: "Drag your tasks onto the timeline to give them a time slot. Move the start and finish lines to set your day, then press `{done}`." },
];

export const WEEK_GUIDE_STEPS = [
  { title: "Review", text: "Unfinished tasks from earlier days and weeks: move them to `This week`, back to the `Backlog`, or mark them done." },
  { title: "Tickets", text: "Your open tickets as a board, one row per project. Press `New task` on a ticket to plan work for it this week: leave the name empty to use the ticket title. The ticket is assigned to the task, and the task appears in `This week` on the right." },
  { title: "Backlog", text: "Pull what belongs into the week: press `This week` on a backlog card, or drag it across. Add anything new that is on your mind, and drag tasks you will not get to back to the `Backlog`." },
  { title: "Schedule", text: "Drag the week's tasks onto the days. Each day shows its meetings on top and how full it is. Tasks without a day stay in the list on the left." },
  { title: "Check", text: "Look at the whole week: is any day too full, is anything still without a day? Fix it with the `Back` button, then press `{done}`." },
];
export const WEEK_REMINDER = "Don't plan 100% of your days. Unforeseen meetings, calls, emergencies and tasks will cross your way: keep about 20% of every day free.";

export interface GuideCtx { overdue: number; }

/** Interactive "plan my day" guide: a vertical stepper (finished steps tick off, the current one opens with its instructions) with Back / Next underneath. The Review step only exists when something is overdue. */
export function renderGuide(plugin: SamayaPlugin, host: HTMLElement, ctx: GuideCtx) {
  const g = plugin.guide; if (!g) return;
  if (g.kind === "shutdown") return renderShutdownGuide(plugin, host);
  if (g.kind === "week") return renderWeekGuide(plugin, host, ctx);
  const first = g.review ? 0 : 1; // first visible step
  const go = (to: number) => { g.step = to; plugin.bus.emit(); };
  const doneLabel = plugin.workday.started ? "Finalize plan" : "Start my day";
  const box = host.createDiv("samaya-plan");

  const top = box.createDiv("samaya-plan-top");
  top.createSpan({ cls: "samaya-plan-kicker", text: "Plan my day" });
  const x = top.createEl("button", { cls: "samaya-plan-cancel clickable-icon", attr: { "aria-label": "Cancel planning" } });
  setIcon(x, "x"); x.onclick = () => plugin.closeGuide();

  const list = box.createEl("ol", { cls: "samaya-plan-steps" });
  GUIDE_STEPS.forEach((st, i) => {
    if (i < first) return;
    const state = i === g.step ? "is-active" : i < g.step ? "is-done" : "is-todo";
    const li = list.createEl("li", { cls: `samaya-plan-step ${state}` });
    const marker = li.createDiv("samaya-plan-marker");
    if (i < g.step) setIcon(marker, "check"); else marker.setText(String(i + 1 - first));
    const main = li.createDiv("samaya-plan-main");
    const title = main.createDiv("samaya-plan-title"); title.createSpan({ text: st.title });
    if (i === 0 && ctx.overdue && i >= g.step) title.createSpan({ cls: "samaya-plan-badge", text: String(ctx.overdue) });
    if (i < g.step) { li.addClass("is-link"); li.onclick = () => go(i); li.setAttr("title", `Back to ${st.title}`); }
    if (i === g.step) richText(main.createDiv("samaya-plan-text"), st.text.replace("{done}", doneLabel));
  });

  const nav = box.createDiv("samaya-plan-nav");
  if (g.step > first) nav.createEl("button", { text: "Back", cls: "samaya-plan-back" }).onclick = () => go(g.step - 1);
  const last = g.step === GUIDE_STEPS.length - 1;
  nav.createEl("button", { text: last ? doneLabel : "Next", cls: "mod-cta samaya-plan-next" }).onclick = () => { if (last) void plugin.finishGuide(); else go(g.step + 1); };
}

/** End of day: a single step. Tick off forgotten tasks in the Tasks column, then finalize. */
function renderShutdownGuide(plugin: SamayaPlugin, host: HTMLElement) {
  const box = host.createDiv("samaya-plan");
  const top = box.createDiv("samaya-plan-top");
  top.createSpan({ cls: "samaya-plan-kicker", text: "End my day" });
  const x = top.createEl("button", { cls: "samaya-plan-cancel clickable-icon", attr: { "aria-label": "Cancel" } });
  setIcon(x, "x"); x.onclick = () => plugin.closeGuide();
  const li = box.createEl("ol", { cls: "samaya-plan-steps" }).createEl("li", { cls: "samaya-plan-step is-active" });
  li.createDiv("samaya-plan-marker").setText("1");
  const main = li.createDiv("samaya-plan-main");
  main.createDiv("samaya-plan-title").createSpan({ text: "Check off finished tasks" });
  richText(main.createDiv("samaya-plan-text"), "Did you finish something and forget to tick it off? Check off any finished tasks in the list. Then press `End my day`.");
  const nav = box.createDiv("samaya-plan-nav");
  nav.createEl("button", { text: "End my day", cls: "mod-cta samaya-plan-next" }).onclick = () => { void plugin.finishShutdown(); };
}

/** "Plan my week": same stepper as the day guide, with the reminder to leave room for the unexpected under every step. */
function renderWeekGuide(plugin: SamayaPlugin, host: HTMLElement, ctx: GuideCtx) {
  const g = plugin.guide!; const vis = weekSteps(g.review, !!g.tickets); const pos = vis.indexOf(g.step);
  const go = (to: number) => { g.step = to; plugin.bus.emit(); };
  const doneLabel = "Finish week plan";
  const box = host.createDiv("samaya-plan");
  const top = box.createDiv("samaya-plan-top");
  top.createSpan({ cls: "samaya-plan-kicker", text: "Plan my week" });
  const x = top.createEl("button", { cls: "samaya-plan-cancel clickable-icon", attr: { "aria-label": "Cancel planning" } });
  setIcon(x, "x"); x.onclick = () => plugin.closeGuide();

  const list = box.createEl("ol", { cls: "samaya-plan-steps" });
  WEEK_GUIDE_STEPS.forEach((st, i) => {
    if (!vis.includes(i)) return;
    const state = i === g.step ? "is-active" : i < g.step ? "is-done" : "is-todo";
    const li = list.createEl("li", { cls: `samaya-plan-step ${state}` });
    const marker = li.createDiv("samaya-plan-marker");
    if (i < g.step) setIcon(marker, "check"); else marker.setText(String(vis.indexOf(i) + 1));
    const main = li.createDiv("samaya-plan-main");
    const title = main.createDiv("samaya-plan-title"); title.createSpan({ text: st.title });
    if (i === 0 && ctx.overdue && i >= g.step) title.createSpan({ cls: "samaya-plan-badge", text: String(ctx.overdue) });
    if (i < g.step) { li.addClass("is-link"); li.onclick = () => go(i); li.setAttr("title", `Back to ${st.title}`); }
    if (i === g.step) richText(main.createDiv("samaya-plan-text"), st.text.replace("{done}", doneLabel));
  });

  const nav = box.createDiv("samaya-plan-nav");
  if (pos > 0) nav.createEl("button", { text: "Back", cls: "samaya-plan-back" }).onclick = () => go(vis[pos - 1]);
  const last = pos === vis.length - 1;
  nav.createEl("button", { text: last ? doneLabel : "Next", cls: "mod-cta samaya-plan-next" }).onclick = () => { if (last) plugin.finishWeekGuide(); else go(vis[pos + 1]); };

  const rem = box.createDiv("samaya-plan-reminder");
  setIcon(rem.createSpan("samaya-plan-reminder-icon"), "life-buoy");
  rem.createSpan({ text: WEEK_REMINDER });
}
