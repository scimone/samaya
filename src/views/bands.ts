import type SamayaPlugin from "../main";
import { hmToMin, minToHm } from "../util";
import { nowMin } from "../workday";

/**
 * Lunch window (drag to move, drag the edges to resize - saved as the default) and today's logged
 * breaks as hatched bands behind the items of a timeline lane.
 */
export function addBands(plugin: SamayaPlugin, lane: HTMLElement, date: string, startH: number, endH: number, hourH: number | (() => number), todayStr: string, cssHour?: string) {
  const s = plugin.settings; const hpx = () => (typeof hourH === "function" ? hourH() : hourH); const px = (m: number) => ((m - startH * 60) / 60) * hpx();
  const band = (from: number, to: number, label: string, cls: string) => {
    const a = Math.max(from, startH * 60), b = Math.min(to, endH * 60); if (b <= a) return null;
    const el = lane.createDiv({ cls: `samaya-band ${cls}` });
    if (cssHour) { el.style.top = `calc(${(a - startH * 60) / 60} * ${cssHour})`; el.style.height = `calc(${(b - a) / 60} * ${cssHour})`; } // stretches with the hours
    else { el.style.top = `${px(a)}px`; el.style.height = `${px(b) - px(a)}px`; }
    const lbl = el.createSpan({ cls: "samaya-band-label", text: label });
    return { el, lbl };
  };

  const [ls, le] = plugin.lunchFor(date);
  const lunch = band(ls, le, "Lunch", "is-lunch is-editable");
  if (lunch) {
    const { el, lbl } = lunch; el.title = "Drag to move this day's lunch, drag the edges to resize. Double-click resets to the default.";
    el.addEventListener("dblclick", () => { void plugin.setLunch(date, null, null); });
    const top = el.createDiv({ cls: "samaya-band-handle is-top" }), bottom = el.createDiv({ cls: "samaya-band-handle is-bottom" });
    el.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation();
      const mode = e.target === top ? "top" : e.target === bottom ? "bottom" : "move";
      const y0 = e.clientY, slot = Math.max(5, s.slotMinutes); const lo = startH * 60, hi = endH * 60;
      let ns = ls, ne = le;
      const move = (ev: PointerEvent) => {
        const dm = Math.round((((ev.clientY - y0) / hpx()) * 60) / slot) * slot;
        if (mode === "move") { const len = le - ls; ns = Math.max(lo, Math.min(hi - len, ls + dm)); ne = ns + len; }
        else if (mode === "top") { ns = Math.max(lo, Math.min(le - slot, ls + dm)); ne = le; }
        else { ne = Math.min(hi, Math.max(ls + slot, le + dm)); ns = ls; }
        el.style.top = `${px(ns)}px`; el.style.height = `${px(ne) - px(ns)}px`; lbl.setText(`Lunch ${minToHm(ns)}–${minToHm(ne)}`);
      };
      const up = async () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        if (ns === ls && ne === le) return;
        await plugin.setLunch(date, minToHm(ns), minToHm(ne)); // this day only; the default in the settings is untouched
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
  }

  const log = plugin.workday.log;
  if (log && log.date === date && date === todayStr) {
    log.breaks.forEach(b => { if (b.kind !== "lunch") band(hmToMin(b.start), hmToMin(b.end), "Break", "is-logged"); else if (hmToMin(b.start) !== ls || hmToMin(b.end) !== le) band(hmToMin(b.start), hmToMin(b.end), "Lunch (logged)", "is-logged"); }); // a logged lunch on the lunch window itself (the one subtracted when the day ends) is the same band: not drawn twice
    if (log.open) band(hmToMin(log.open.start), Math.max(nowMin(), hmToMin(log.open.start) + 1), "On break", "is-logged");
  }
}
