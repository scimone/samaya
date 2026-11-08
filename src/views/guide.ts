import type SamayaPlugin from "../main";

export const GUIDE_STEPS = [
  { title: "Review", text: "Anything left over from earlier days? Move it to today, back to the backlog, or mark it done." },
  { title: "Pick", text: "Choose what you want to do today from the This week and Backlog tabs in the sidebar: press Today on a card, or drag it into the list." },
  { title: "Timebox", text: "Drag your tasks onto the timeline to give them a time slot. Move the start and finish lines to set your day." },
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
  head.createEl("button", { cls: "samaya-mini", text: "Cancel" }).onclick = () => { plugin.guide = null; plugin.bus.emit(); };
  const step = GUIDE_STEPS[g.step];
  box.createEl("h3", { text: `${g.step + 1 - first}. ${step.title}` });
  box.createDiv({ cls: "samaya-guide-text", text: step.text });

  if (g.step === 0) {
    box.createDiv({ cls: "samaya-guide-status", text: ctx.overdue ? `${ctx.overdue} unfinished task${ctx.overdue > 1 ? "s" : ""} from earlier days (see the sidebar)` : "All cleared." });
  }

  const nav = box.createDiv("samaya-guide-nav");
  if (g.step > first) nav.createEl("button", { text: "Back" }).onclick = () => { g.step--; plugin.bus.emit(); };
  const last = g.step === GUIDE_STEPS.length - 1;
  nav.createEl("button", { text: last ? "Start my day" : "Next", cls: "mod-cta" }).onclick = () => { if (last) void plugin.finishGuide(); else { g.step++; plugin.bus.emit(); } };
}
