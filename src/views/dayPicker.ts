import { setIcon } from "obsidian";
import { srName } from "./srname";
import { monthGrid } from "../monthgrid";
import { parseYmd, today } from "../util";

/** Places a popover at a screen position, inside the window. */
export function placeAt(box: HTMLElement, x: number, y: number) {
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x))}px`; box.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, y))}px`;
}
/** Closes `box` on Escape or a click outside; returns the close function. */
let closeOpen: (() => void) | null = null;
/** Close the popover that is open, with its listeners (only one at a time). */
export function closePopover(): void { closeOpen?.(); }
/** `except`: an element (the button that opened it) whose clicks do not count as outside. */
export function dismissable(box: HTMLElement, except?: HTMLElement): () => void {
  closePopover();
  const close = () => { if (closeOpen === close) closeOpen = null; box.remove(); document.removeEventListener("mousedown", away, true); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", close); };
  const away = (e: MouseEvent) => { if (!box.contains(e.target as Node) && !except?.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("mousedown", away, true); document.addEventListener("keydown", key, true); window.addEventListener("resize", close);
  closeOpen = close;
  return close;
}

/** The month grid of a calendar: header with month / year steps, weekday letters and day buttons. `paint` decorates each day button. */
export function drawMonth(box: HTMLElement, view: { year: number; month: number }, redraw: () => void, paint: (b: HTMLElement, date: string, inMonth: boolean) => void, pick: (date: string) => void) {
  const head = box.createDiv("samaya-pp-head");
  const step = (icon: string, label: string, months: number) => { const b = head.createEl("button", { cls: "samaya-pp-step", attr: { "aria-label": label } }); setIcon(b, icon); b.onclick = () => { const d = new Date(view.year, view.month + months, 1); view.year = d.getFullYear(); view.month = d.getMonth(); redraw(); }; };
  step("chevrons-left", "Previous year", -12);
  step("chevron-left", "Previous month", -1);
  head.createSpan({ cls: "samaya-pp-title", text: new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }) });
  step("chevron-right", "Next month", 1); step("chevrons-right", "Next year", 12);
  const grid = box.createDiv("samaya-dp-grid");
  for (let i = 0; i < 7; i++) grid.createSpan({ cls: "samaya-dp-dow", text: parseYmd(`2026-11-${String(9 + i).padStart(2, "0")}`).toLocaleDateString(undefined, { weekday: "narrow" }) });
  const now = today();
  for (const w of monthGrid(view.year, view.month)) for (const d of w.days) {
    const b = grid.createEl("button", { cls: "samaya-dp-day" + (d.inMonth ? "" : " is-out") + (d.date === now ? " is-now" : ""), text: String(parseYmd(d.date).getDate()) });
    paint(b, d.date, d.inMonth); b.onclick = () => pick(d.date);
  }
}

/** A small month calendar popover at a screen position; picking a day calls `run(day)` and closes it. */
export function openDayPicker(o: { x: number; y: number; value?: string }, run: (day: string) => void): void {
  const base = parseYmd(o.value || today()); const view = { year: base.getFullYear(), month: base.getMonth() };
  const box = document.body.createDiv({ cls: "samaya-pp samaya-dp", attr: { role: "dialog" } }); srName(box, "Pick a day");
  const close = dismissable(box);
  const draw = () => { box.empty(); drawMonth(box, view, draw, (b, d) => { if (d === o.value) b.addClass("is-selected"); }, d => { close(); run(d); }); };
  draw(); placeAt(box, o.x, o.y);
}
