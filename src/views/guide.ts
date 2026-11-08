import type SamayaPlugin from "../main";
import { journalWants, readJournalSection } from "../journal";
import { fmtDur, today } from "../util";

export const GUIDE_STEPS = [
  { title: "Review", text: "Anything left over from earlier days? Move it to today, back to the backlog, or mark it done." },
  { title: "Pick", text: "Choose what you want to do today from the This week and Backlog tabs in the sidebar: press Today on a card, or drag it into the list or onto the timeline." },
  { title: "Timebox", text: "Drag your tasks onto the timeline to give them a time slot. Watch the free capacity." },
  { title: "Start", text: "What could get in your way? And when do you want to stop?" },
];

export interface GuideCtx { overdue: number; planned: number; free: number; }

/** Interactive "plan my day" guide shown on top of the daily planner. */
export function renderGuide(plugin: SamayaPlugin, host: HTMLElement, ctx: GuideCtx) {
  const g = plugin.guide; if (!g) return;
  const box = host.createDiv("samaya-guide");
  const head = box.createDiv("samaya-guide-head");
  head.createSpan({ cls: "samaya-guide-kicker", text: "PLAN MY DAY" });
  const dots = head.createDiv("samaya-guide-dots");
  GUIDE_STEPS.forEach((_s, i) => dots.createSpan({ cls: "samaya-guide-dot" + (i === g.step ? " is-active" : i < g.step ? " is-done" : "") }));
  head.createEl("button", { cls: "samaya-mini", text: "Cancel" }).onclick = () => { plugin.guide = null; plugin.bus.emit(); };
  const step = GUIDE_STEPS[g.step];
  box.createEl("h3", { text: `${g.step + 1}. ${step.title}` });
  box.createDiv({ cls: "samaya-guide-text", text: step.text });

  const status = box.createDiv("samaya-guide-status");
  if (g.step === 0) status.setText(ctx.overdue ? `${ctx.overdue} unfinished task${ctx.overdue > 1 ? "s" : ""} from earlier days (highlighted below)` : "Nothing left over - clean slate.");
  if (g.step === 1 || g.step === 2) {
    status.setText(`Planned ${fmtDur(ctx.planned)} of ${fmtDur(ctx.free)} free capacity`);
    status.toggleClass("is-over", ctx.planned > ctx.free);
  }
  if (g.step === 3) {
    if (journalWants(plugin.settings, "journalObstacles")) {
      box.createEl("label", { text: "Obstacles in my way (one per line)" });
      const ta = box.createEl("textarea", { cls: "samaya-reflection" }); ta.rows = 4; ta.value = g.obstacles ?? "";
      if (g.obstacles === null) void readJournalSection(plugin.app, plugin.settings, today(), "Obstacles in my way").then(l => { if (g.obstacles === null) { g.obstacles = l.join("\n"); ta.value = g.obstacles; } });
      ta.oninput = () => { g.obstacles = ta.value; };
    }
    const row = box.createDiv("samaya-guide-row");
    row.createEl("label", { text: "I plan to finish at" });
    const t = row.createEl("input", { type: "time" }); t.value = g.shutdown.padStart(5, "0"); t.onchange = () => { if (t.value) g.shutdown = t.value; };
  }

  const nav = box.createDiv("samaya-guide-nav");
  if (g.step > 0) nav.createEl("button", { text: "Back" }).onclick = () => { g.step--; plugin.bus.emit(); };
  const last = g.step === GUIDE_STEPS.length - 1;
  nav.createEl("button", { text: last ? "Start my day" : "Next", cls: "mod-cta" }).onclick = () => { if (last) void plugin.finishGuide(); else { g.step++; plugin.bus.emit(); } };
}
