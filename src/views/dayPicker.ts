import { setIcon } from "obsidian";
import { monthGrid } from "../monthgrid";
import { parseYmd, today } from "../util";

export interface DayPickerOpts {
  /** where the popover appears (viewport px, e.g. the right-click position) */ x: number; y: number;
  /** the day selected at the start (and the month shown) */ value?: string;
  /** "range": a click picks the first day, the next click the last one */ range?: boolean;
  /** the range shown at the start */ from?: string; to?: string;
}

/** A small month calendar popover at a screen position. Single mode calls `run(day)`; range mode calls `run(first, last)` after two clicks (the earlier one first). Closes on pick, Escape or a click outside. */
export function openDayPicker(o: DayPickerOpts, run: (start: string, end: string) => void): void {
  document.querySelector(".samaya-dp")?.remove();
  const base = parseYmd(o.value || o.from || today()); let year = base.getFullYear(), month = base.getMonth();
  let a = "", hover = "";
  const box = document.body.createDiv({ cls: "samaya-pp samaya-dp", attr: { role: "dialog", "aria-label": o.range ? "Pick a time frame" : "Pick a day" } });
  const close = () => { box.remove(); document.removeEventListener("mousedown", away, true); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", close); };
  const away = (e: MouseEvent) => { if (!box.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const draw = () => {
    box.empty();
    const head = box.createDiv("samaya-pp-head");
    const step = (icon: string, label: string, n: number) => { const b = head.createEl("button", { cls: "samaya-pp-step", attr: { "aria-label": label } }); setIcon(b, icon); b.onclick = () => { const d = new Date(year, month + n, 1); year = d.getFullYear(); month = d.getMonth(); draw(); }; };
    step("chevron-left", "Previous month", -1);
    head.createSpan({ cls: "samaya-pp-title", text: new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }) });
    step("chevron-right", "Next month", 1);
    if (o.range) box.createDiv({ cls: "samaya-dp-hint", text: a ? "Pick the last day" : "Pick the first day" });
    const grid = box.createDiv("samaya-dp-grid");
    for (let i = 0; i < 7; i++) grid.createSpan({ cls: "samaya-dp-dow", text: parseYmd(`2026-11-${String(9 + i).padStart(2, "0")}`).toLocaleDateString(undefined, { weekday: "narrow" }) });
    const now = today();
    // the range being picked (first click made: up to the hovered day), else the one passed in
    const lo = o.range ? (a ? (hover && hover < a ? hover : a) : o.from ?? "") : "", hi = o.range ? (a ? (hover && hover > a ? hover : a) : o.to ?? "") : "";
    for (const w of monthGrid(year, month)) for (const d of w.days) {
      const inR = !!lo && d.date >= lo && d.date <= hi, edge = !!lo && (d.date === lo || d.date === hi);
      const b = grid.createEl("button", { cls: "samaya-dp-day" + (d.inMonth ? "" : " is-out") + (d.date === now ? " is-now" : "") + (o.range ? (inR ? " is-inrange" : "") + (edge ? " is-selected" : "") : d.date === o.value ? " is-selected" : ""), text: String(parseYmd(d.date).getDate()) });
      b.onmouseenter = () => { if (o.range && a && hover !== d.date) { hover = d.date; draw2(); } };
      b.onclick = () => {
        if (!o.range) { close(); run(d.date, d.date); return; }
        if (!a) { a = d.date; hover = ""; draw(); return; }
        close(); run(d.date < a ? d.date : a, d.date < a ? a : d.date);
      };
    }
  };
  // hovering while picking the last day only repaints the day cells (the buttons under the pointer would otherwise vanish mid-hover)
  const draw2 = () => { const keep = box.scrollTop; draw(); box.scrollTop = keep; };
  draw();
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, o.x))}px`; box.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, o.y))}px`;
  document.addEventListener("mousedown", away, true); document.addEventListener("keydown", key, true); window.addEventListener("resize", close);
}
