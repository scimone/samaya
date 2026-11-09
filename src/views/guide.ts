import type SamayaPlugin from "../main";
import { richText } from "./common";

export const GUIDE_STEPS = [
  { title: "Review", text: "Unfinished tasks from earlier days: move them to `Today`, `Tomorrow` or `This week`, back to the `Backlog`, or mark them done." },
  { title: "Pick", text: "Choose what you want to do today from `This week` or `Backlog`: press `Today` on a card, or drag it into the list. You can also add new tasks here, or drag a planned task back to `This week` or `Backlog` to swap it out." },
  { title: "Timebox", text: "Drag your tasks onto the timeline to give them a time slot. Move the start and finish lines to set your day, then press `Start my day`." },
];

export interface GuideCtx { overdue: number; }

/** Interactive "plan my day" guide shown on top of the daily planner. The Review step only exists when something is overdue. */
export function renderGuide(plugin: SamayaPlugin, host: HTMLElement, ctx: GuideCtx) {
  const g = plugin.guide; if (!g) return;
  const first = g.review ? 0 : 1; // first visible step
  const box = host.createDiv("samaya-guide");
  const head = box.createDiv("samaya-guide-head");
  head.createSpan({ cls: "samaya-guide-kicker", text: "PLAN MY DAY" });
  const dots = head.createDiv("samaya-guide-dots");
  GUIDE_STEPS.forEach((_s, i) => { if (i >= first) dots.createSpan({ cls: "samaya-guide-dot" + (i === g.step ? " is-active" : i < g.step ? " is-done" : "") }); });
  head.createSpan({ cls: "samaya-guide-stepno", text: `Step ${g.step + 1 - first} of ${GUIDE_STEPS.length - first}` });
  head.createEl("button", { cls: "samaya-mini", text: "Cancel" }).onclick = () => plugin.closeGuide();
  const step = GUIDE_STEPS[g.step];
  const titleRow = box.createDiv("samaya-guide-titlerow"); // buttons next to the title: always in the same place, close to the text
  titleRow.createEl("h3", { text: step.title });
  const nav = titleRow.createDiv("samaya-guide-nav");
  const back = nav.createEl("button", { text: "Back", cls: "samaya-guide-back" }); // always there, so Next never moves
  if (g.step > first) back.onclick = () => { g.step--; plugin.bus.emit(); }; else back.addClass("is-hidden");
  richText(box.createDiv("samaya-guide-text"), step.text);
  const last = g.step === GUIDE_STEPS.length - 1;
  nav.createEl("button", { text: last ? "Start my day" : "Next", cls: "mod-cta samaya-guide-next" }).onclick = () => { if (last) void plugin.finishGuide(); else { g.step++; plugin.bus.emit(); } };
}
