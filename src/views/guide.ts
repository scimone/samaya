import { setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { richText } from "./common";

export const GUIDE_STEPS = [
  { title: "Review", text: "Unfinished tasks from earlier days: move them to `Today`, `Tomorrow` or `This week`, back to the `Backlog`, or mark them done." },
  { title: "Pick", text: "Choose what you want to do today from `This week` or `Backlog`: press `Today` on a card, or drag it into the list. You can also add new tasks here, or drag a planned task back to `This week` or `Backlog` to swap it out." },
  { title: "Timebox", text: "Drag your tasks onto the timeline to give them a time slot. Move the start and finish lines to set your day, then press `Start my day` (or `Finalize plan` if your day has already started)." },
];

export interface GuideCtx { overdue: number; }

/** Interactive "plan my day" guide: a vertical stepper (finished steps tick off, the current one opens with its instructions) with Back / Next underneath. The Review step only exists when something is overdue. */
export function renderGuide(plugin: SamayaPlugin, host: HTMLElement, ctx: GuideCtx) {
  const g = plugin.guide; if (!g) return;
  const first = g.review ? 0 : 1; // first visible step
  const go = (to: number) => { g.step = to; plugin.bus.emit(); };
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
    if (i === g.step) richText(main.createDiv("samaya-plan-text"), st.text);
  });

  const nav = box.createDiv("samaya-plan-nav");
  if (g.step > first) nav.createEl("button", { text: "Back", cls: "samaya-plan-back" }).onclick = () => go(g.step - 1);
  const last = g.step === GUIDE_STEPS.length - 1;
  nav.createEl("button", { text: last ? (plugin.workday.started ? "Finalize plan" : "Start my day") : "Next", cls: "mod-cta samaya-plan-next" }).onclick = () => { if (last) void plugin.finishGuide(); else go(g.step + 1); };
}
