import type SamayaPlugin from "../main";
import { hmToMin, minToHm } from "../util";

/** Draggable start and finish lines of the working day of ONE day (the settings hold the default; double-click a label to go back to it), with the hours outside shaded. */
export function renderDayLines(plugin: SamayaPlugin, date: string, lane: HTMLElement, grid: HTMLElement, o: { startH: number; endH: number; slot: number }, hourH: number, minToPx: (m: number) => number) {
  const lo = o.startH * 60, hi = o.endH * 60;
  const clamp = (m: number) => Math.max(lo, Math.min(hi, m));
  const [w0, w1] = plugin.workWindowFor(date); const val = { start: w0, end: w1 };
  const shadeTop = lane.createDiv("samaya-dayshade"); shadeTop.style.top = "0px";
  const shadeBot = lane.createDiv("samaya-dayshade");
  const paints: Array<() => void> = [];
  const mk = (key: "start" | "end", label: string) => {
    const el = lane.createDiv("samaya-dayline is-" + key);
    const lab = el.createSpan({ cls: "samaya-dayline-label", attr: { title: `Drag to move the ${label.toLowerCase()} line for this day. Double-click: back to the default from the settings` } });
    const paint = () => {
      el.style.top = `${minToPx(clamp(val[key]))}px`; lab.setText(`${label} ${minToHm(val[key])}`);
      shadeTop.style.height = `${Math.max(0, minToPx(clamp(val.start)))}px`;
      const endPx = minToPx(clamp(val.end));
      shadeBot.style.top = `${endPx}px`; shadeBot.style.height = `${Math.max(0, grid.clientHeight - endPx)}px`;
    };
    lab.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation();
      const y0 = e.clientY, m0 = clamp(val[key]);
      const move = (ev: PointerEvent) => {
        const m = Math.round((m0 + ((ev.clientY - y0) / hourH) * 60) / o.slot) * o.slot;
        val[key] = key === "start" ? Math.max(lo, Math.min(val.end - o.slot, m)) : Math.min(hi, Math.max(val.start + o.slot, m));
        paints.forEach(f => f());
      };
      const up = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        void plugin.setWorkWindow(date, [minToHm(val.start), minToHm(val.end)]); // free capacity depends on the lines
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
    lab.addEventListener("dblclick", () => { void plugin.setWorkWindow(date, null); });
    paints.push(paint);
  };
  mk("start", "Start"); mk("end", "Finish");
  paints.forEach(f => f());
}
