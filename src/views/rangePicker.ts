import { addDays, parseYmd, startOfWeek, today, ymd } from "../util";
import { dismissable, drawMonth, placeAt } from "./dayPicker";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const monthsFrom = (d: string, n: number): string => { const x = parseYmd(d); const last = new Date(x.getFullYear(), x.getMonth() + n + 1, 0).getDate(); return ymd(new Date(x.getFullYear(), x.getMonth() + n, Math.min(x.getDate(), last))); }; // Jan 31 + 1 month = Feb 28, not Mar 3

/** Time frames that need no clicking through months: relative to today. */
function presets(): Array<[string, string, string]> {
  const t = parseYmd(today()); const y = t.getFullYear(), m = t.getMonth(), q = Math.floor(m / 3) * 3; const w = startOfWeek(today());
  const month = (n: number): [string, string] => [ymd(new Date(y, m + n, 1)), ymd(new Date(y, m + n + 1, 0))];
  const quarter = (n: number): [string, string] => [ymd(new Date(y, q + n * 3, 1)), ymd(new Date(y, q + n * 3 + 3, 0))];
  return [
    ["This week", w, addDays(w, 6)], ["Next week", addDays(w, 7), addDays(w, 13)],
    ["This month", ...month(0)], ["Next month", ...month(1)],
    ["This quarter", ...quarter(0)], ["Next quarter", ...quarter(1)],
    ["This year", ymd(new Date(y, 0, 1)), ymd(new Date(y, 11, 31))], ["Next year", ymd(new Date(y + 1, 0, 1)), ymd(new Date(y + 1, 11, 31))],
  ];
}
/** Lengths counted from the start date: end = start + length - 1 day. */
const LENGTHS: Array<[string, (s: string) => string]> = [
  ["1 week", s => addDays(s, 6)], ["2 weeks", s => addDays(s, 13)], ["1 month", s => addDays(monthsFrom(s, 1), -1)],
  ["3 months", s => addDays(monthsFrom(s, 3), -1)], ["6 months", s => addDays(monthsFrom(s, 6), -1)], ["1 year", s => addDays(monthsFrom(s, 12), -1)],
];

/**
 * Popover for setting a time frame: a Start and an End date field (type a date, or click a day: the first click fills Start, the next End), quick time frames
 * (this week ... next year), lengths counted from the start (1 week ... 1 year) and a calendar with month and year steps. Nothing is saved until "Apply".
 */
export function openRangePicker(o: { x: number; y: number; start?: string; end?: string }, run: (start: string, end: string) => void, clear?: () => void): void {
  document.querySelector(".samaya-dp")?.remove();
  let start = o.start ?? "", end = o.end ?? ""; let active: "start" | "end" = start && !end ? "end" : "start";
  const base = parseYmd(start || today()); const view = { year: base.getFullYear(), month: base.getMonth() };
  const box = document.body.createDiv({ cls: "samaya-pp samaya-dp samaya-rp", attr: { role: "dialog", "aria-label": "Plan project" } });
  const close = dismissable(box);
  const show = (d: string) => { if (YMD.test(d)) { const x = parseYmd(d); view.year = x.getFullYear(); view.month = x.getMonth(); } };
  const set = (s: string, e: string) => { start = s; end = e; show(s); draw(); };

  // fixed skeleton: the two fields keep focus while the rest repaints
  const fields = box.createDiv("samaya-rp-fields"); const inputs = {} as Record<"start" | "end", HTMLInputElement>;
  for (const k of ["start", "end"] as const) {
    const col = fields.createDiv("samaya-rp-field"); col.createSpan({ cls: "samaya-rp-label", text: k === "start" ? "Start" : "End" });
    const inp = inputs[k] = col.createEl("input", { type: "date", cls: "samaya-rp-input", attr: { "aria-label": k === "start" ? "Start date" : "End date" } });
    inp.addEventListener("focus", () => { active = k; paintFields(); });
    inp.addEventListener("change", () => {
      if (!YMD.test(inp.value)) return;
      if (k === "start") { start = inp.value; if (end && end < start) end = start; } else { end = inp.value; if (start && start > end) start = end; }
      show(inp.value); draw();
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter" && apply()) e.preventDefault(); });
  }
  const body = box.createDiv("samaya-rp-body"); const foot = box.createDiv("samaya-rp-foot");
  const apply = (): boolean => { if (!YMD.test(start)) return false; close(); run(start, YMD.test(end) && end >= start ? end : start); return true; };
  const paintFields = () => { for (const k of ["start", "end"] as const) { inputs[k].value = k === "start" ? start : end; inputs[k].parentElement!.toggleClass("is-active", active === k); } };

  const draw = () => {
    paintFields(); body.empty(); foot.empty();
    const chips = (label: string, items: Array<[string, () => void, boolean]>) => {
      const row = body.createDiv("samaya-rp-row"); row.createSpan({ cls: "samaya-rp-label", text: label });
      const wrap = row.createDiv("samaya-rp-chips");
      for (const [text, fn, on] of items) wrap.createEl("button", { cls: "samaya-rp-chip" + (on ? " is-on" : ""), text }).onclick = fn;
    };
    chips("Time frame", presets().map(([n, s, e]): [string, () => void, boolean] => [n, () => set(s, e), start === s && end === e]));
    if (YMD.test(start)) chips("Length", LENGTHS.map(([n, f]): [string, () => void, boolean] => [n, () => { end = f(start); show(end); draw(); }, end === f(start)]));
    const cal = body.createDiv("samaya-rp-cal");
    drawMonth(cal, view, draw, (b, d) => {
      const inR = YMD.test(start) && YMD.test(end) && d >= start && d <= end; if (inR) b.addClass("is-inrange");
      if (d === start || d === end) b.addClass("is-selected");
    }, d => {
      if (active === "start") { start = d; if (end && end < d) end = d; active = "end"; }
      else if (YMD.test(start) && d < start) { end = start; start = d; } else { end = d; }
      draw();
    });
    const span = YMD.test(start) && YMD.test(end) ? Math.round((parseYmd(end).getTime() - parseYmd(start).getTime()) / 86400000) + 1 : 0;
    foot.createSpan({ cls: "samaya-rp-sum", text: span ? `${span} day${span > 1 ? "s" : ""}` : active === "start" ? "Pick the first day" : "Pick the last day" });
    if (clear) foot.createEl("button", { cls: "samaya-rp-clear", text: "Remove from timeline" }).onclick = () => { close(); clear(); };
    const ok = foot.createEl("button", { cls: "mod-cta samaya-rp-apply", text: "Apply" }); ok.disabled = !YMD.test(start); ok.onclick = () => { apply(); };
  };
  draw(); placeAt(box, o.x, o.y);
}
