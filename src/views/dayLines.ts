import type SamayaPlugin from "../main";
import { hmToMin, minToHm } from "../util";

/** Draggable start and finish lines of the working day (settings dayStartTime / shutdownTime), with the hours outside shaded. */
export function renderDayLines(plugin: SamayaPlugin, lane: HTMLElement, grid: HTMLElement, o: { startH: number; endH: number; slot: number }, hourH: number, minToPx: (m: number) => number) {
  const s = plugin.settings; const lo = o.startH * 60, hi = o.endH * 60;
  const clamp = (m: number) => Math.max(lo, Math.min(hi, m));
  const val = { start: hmToMin(s.dayStartTime || "09:00"), end: hmToMin(s.shutdownTime || "17:30") };
  const shadeTop = lane.createDiv("samaya-dayshade"); shadeTop.style.top = "0px";
  const shadeBot = lane.createDiv("samaya-dayshade");
  const paints: Array<() => void> = [];
  const mk = (key: "start" | "end", label: string) => {
    const el = lane.createDiv("samaya-dayline is-" + key);
    const lab = el.createSpan({ cls: "samaya-dayline-label", attr: { title: `Drag to move the ${label.toLowerCase()} line` } });
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
        if (key === "start") s.dayStartTime = minToHm(val.start); else s.shutdownTime = minToHm(val.end);
        void plugin.saveSettings().then(() => plugin.bus.emit()); // free capacity depends on the lines
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
    paints.push(paint);
  };
  mk("start", "Start"); mk("end", "Finish");
  paints.forEach(f => f());
}
