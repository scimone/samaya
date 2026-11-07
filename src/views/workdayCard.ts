import type SamayaPlugin from "../main";
import { fmtDur, hmToMin, minToHm, today } from "../util";
import { nowMin } from "../workday";
import { dailyTarget, fmtSigned, workedMinutes } from "../worktime";

/** Minimal one-line workday status with inline actions. Repaints itself until removed from the DOM. */
export function renderWorkdayCard(plugin: SamayaPlugin, host: HTMLElement, o: { compact?: boolean } = {}) {
  const wd = plugin.workday; const s = plugin.settings;
  let timer = 0; let off = () => {};
  const paint = () => {
    if (!host.isConnected) { off(); window.clearInterval(timer); return; }
    host.empty();
    const l = wd.log; const target = dailyTarget(s.weeklyHours, s.workDays, today());
    const strip = host.createDiv({ cls: "samaya-wd" + (l?.open ? " is-break" : l?.start && !l.end ? " is-work" : "") });
    const line = strip.createDiv("samaya-wd-line");
    const text = line.createDiv("samaya-wd-text");
    const actions = line.createDiv("samaya-wd-actions");
    const meta = (t: string) => { if (!o.compact) text.createSpan({ cls: "samaya-wd-meta", text: t }); };
    const act = (label: string, fn: () => void, cta = false) => { actions.createEl("button", { text: label, cls: "samaya-link-btn" + (cta ? " is-cta" : "") }).onclick = fn; };

    if (!l || !l.start) {
      text.createSpan({ cls: "samaya-wd-state", text: "Day not started" });
      act("Plan my day", () => plugin.startGuide(), true); act("Just start", () => { void wd.startDay(); });
      return;
    }
    if (l.end) {
      const worked = workedMinutes(l, 1440);
      text.createSpan({ cls: "samaya-wd-state", text: "Day finished" });
      meta(`${fmtDur(worked)} · ${l.start}–${l.end}${target ? ` · ${fmtSigned(worked - target)}` : ""}`);
      act("Reopen", () => { void wd.reopenDay(); }); act("Dashboard", () => { void plugin.openDashboard(); });
      return;
    }
    const worked = workedMinutes(l, nowMin());
    if (l.open) {
      text.createSpan({ cls: "samaya-wd-state", text: "On break" });
      meta(`${fmtDur(Math.max(0, nowMin() - hmToMin(l.open.start)))} · since ${l.open.start}`);
      act("Back to work", () => { void wd.endBreak(); }, true);
      return;
    }
    text.createSpan({ cls: "samaya-wd-state", text: "Working" });
    const reach = target ? (worked < target ? ` · done ~${minToHm(nowMin() + target - worked)}` : ` · +${fmtDur(worked - target)}`) : "";
    meta(`${fmtDur(worked)} · since ${l.start}${reach}`);
    act("Break", () => { void wd.startBreak(); }); act("End day", () => plugin.startShutdown());
  };
  off = plugin.bus.on(paint);
  timer = window.setInterval(paint, 15000);
  paint();
}
