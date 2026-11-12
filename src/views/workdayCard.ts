import type SamayaPlugin from "../main";
import { fmtDur, hmToMin, minToHm, today } from "../util";
import { nowMin } from "../workday";
import { breakMinutes, fmtSigned, workedMinutes } from "../worktime";

/** Workday status with actions: a minimal one-liner, or (`panel`) a card with the time worked in large type. Repaints itself until removed from the DOM. */
export function renderWorkdayCard(plugin: SamayaPlugin, host: HTMLElement, o: { compact?: boolean; panel?: boolean; /** heading pieces: just the status chip, or just the buttons */ part?: "status" | "actions"; /** status chip of a past week: the average work time per working day instead of a live status */ average?: { avg: number; days: number } | null; /** another day than today: a read-only summary from its log */ date?: string } = {}) {
  const wd = plugin.workday; const s = plugin.settings;
  let timer = 0; let off = () => {};
  const paint = () => {
    if (!host.isConnected) { off(); window.clearInterval(timer); return; }
    host.empty();
    const other = !!o.date && o.date !== today();
    const l = other ? wd.allLogs().find(x => x.date === o.date) ?? null : wd.log; const [winStart, winEnd] = plugin.workWindowFor(o.date ?? today());
    // work time to aim for: finish line minus start line, minus lunch and the other breaks taken
    const [ls, le] = plugin.lunchFor(o.date ?? today()); const lunch = Math.max(0, Math.min(le, winEnd) - Math.max(ls, winStart));
    const others = l ? l.breaks.filter(b => b.kind !== "lunch").reduce((a, b) => a + Math.max(0, hmToMin(b.end) - hmToMin(b.start)), 0) + (l.open && l.open.kind !== "lunch" && !other ? Math.max(0, nowMin() - hmToMin(l.open.start)) : 0) : 0;
    const target = Math.max(0, winEnd - winStart - lunch - others);
    const strip = host.createDiv({ cls: "samaya-wd" + (o.panel ? " samaya-wd-panel" : "") + (o.average !== undefined ? "" : l?.open ? " is-break" : l?.start && !l.end ? " is-work" : "") });
    // what to show: a state label, the main figure, a detail line and the actions
    let state = "", big = "", sub = "", sub2 = ""; let progress = -1;
    const buttons: Array<[string, () => void, boolean?]> = [];
    if (o.average !== undefined) { // a past week: the average, never the live status
      state = "Ø per day"; if (o.average) { big = fmtDur(Math.round(o.average.avg)); sub = `Average work time over ${o.average.days} working day${o.average.days === 1 ? "" : "s"} (weekends and vacation left out)`; } else sub = "No work time logged this week.";
    } else if (other) { // a past or future day: just what was logged
      if (!l || !l.start) { state = "Workday"; sub = o.date! > today() ? "Not started yet." : "No work time logged."; }
      else {
        const end = l.end ?? l.seen ?? null; const worked = workedMinutes({ ...l, end, open: null }, 1440);
        state = "Worked"; big = fmtDur(worked);
        sub = `${l.start}–${l.end ?? (end ? end + "?" : "…")}` + (breakMinutes(l) ? ` · ${fmtDur(breakMinutes(l))} break` : "") + (target ? ` · ${fmtSigned(worked - target)}` : "");
      }
    } else if (!l || !l.start) {
      state = "Day not started";
      if (o.panel || o.part) { sub = "Start the clock when you begin working."; buttons.push(["Start day", () => { void wd.startDay(); }, true]); }
      else { sub = "Plan your day, or just start the clock."; buttons.push(["Plan my day", () => plugin.startGuide(), true], ["Just start", () => { void wd.startDay(); }]); }
    } else if (l.end) {
      const worked = workedMinutes(l, 1440);
      state = "Day finished"; big = fmtDur(worked); sub = `${l.start}–${l.end}${target ? ` · ${fmtSigned(worked - target)}` : ""}`;
      buttons.push(["Reopen", () => { void wd.reopenDay(); }]); if (!o.part) buttons.push(["Dashboard", () => { void plugin.openDashboard(); }]);
    } else if (l.open) {
      state = "On break"; big = fmtDur(Math.max(0, nowMin() - hmToMin(l.open.start))); sub = `since ${l.open.start}`;
      buttons.push(["Back to work", () => { void wd.endBreak(); }, true]);
    } else {
      const worked = workedMinutes(l, nowMin());
      state = "Working"; big = fmtDur(worked);
      sub = `Start time ${l.start} · Finish time ${minToHm(winEnd)}`; // the finish line of the timeline, which can be moved per day
      if (target) sub2 = worked < target ? `${fmtDur(target - worked)} left of ${fmtDur(target)}` : `Target of ${fmtDur(target)} reached (+${fmtDur(worked - target)})`;
      if (target) progress = Math.min(1, worked / target);
      buttons.push(["Break", () => { void wd.startBreak(); }], ["End day", () => plugin.startShutdown()]);
    }

    if (o.part === "status") { // the heading's chip: a dot, the state and the time worked
      strip.addClass("samaya-wd-chip"); strip.title = [sub, sub2].filter(Boolean).join(" · ");
      strip.createSpan({ cls: "samaya-wd-state", text: state });
      if (big) strip.createSpan({ cls: "samaya-wd-chip-fig", text: big });
      return;
    }
    if (o.part === "actions") {
      strip.addClass("is-part-actions");
      buttons.forEach(([label, fn, cta]) => { strip.createEl("button", { text: label, cls: "samaya-hd-btn" + (cta ? " mod-cta" : "") + (label === "End day" ? " is-end-day" : "") }).onclick = fn; });
      return;
    }
    if (o.panel) {
      strip.createDiv({ cls: "samaya-wd-state", text: state });
      if (big) strip.createDiv({ cls: "samaya-wd-figure", text: big });
      if (sub) strip.createDiv({ cls: "samaya-wd-sub", text: sub });
      if (sub2) strip.createDiv({ cls: "samaya-wd-sub", text: sub2 });
      if (progress >= 0) strip.createDiv("samaya-wd-prog").createDiv("samaya-wd-prog-fill").style.width = `${progress * 100}%`;
      const row = strip.createDiv("samaya-wd-buttons");
      buttons.forEach(([label, fn, cta]) => { row.createEl("button", { text: label, cls: cta ? "mod-cta" : "" }).onclick = fn; });
      return;
    }
    const line = strip.createDiv("samaya-wd-line");
    const text = line.createDiv("samaya-wd-text");
    const actions = line.createDiv("samaya-wd-actions");
    text.createSpan({ cls: "samaya-wd-state", text: state });
    if (!o.compact && (big || sub)) text.createSpan({ cls: "samaya-wd-meta", text: [big, sub].filter(Boolean).join(" · ") });
    buttons.forEach(([label, fn, cta]) => { actions.createEl("button", { text: label, cls: "samaya-link-btn" + (cta ? " is-cta" : "") }).onclick = fn; });
  };
  off = plugin.bus.on(paint);
  timer = window.setInterval(paint, 15000);
  paint();
}
