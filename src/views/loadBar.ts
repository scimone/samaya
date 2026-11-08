import { fmtDur } from "../util";

/** "4h planned · 7h free" with a fill bar, like the day columns of the weekly board. */
export function renderLoadBar(parent: HTMLElement, planned: number, free: number, tip = "") {
  const over = planned > free;
  const wrap = parent.createDiv({ cls: "samaya-loadbar" + (over ? " is-over" : "") });
  const label = wrap.createDiv({ cls: "samaya-total" + (over ? " is-over" : ""), text: `${fmtDur(planned)} planned · ${fmtDur(free)} free` });
  if (tip) label.title = tip;
  const bar = wrap.createDiv({ cls: "samaya-col-bar" + (over ? " is-over" : "") });
  bar.createDiv("samaya-col-bar-fill").style.width = `${over || free <= 0 ? (planned > 0 ? 100 : 0) : (planned / free) * 100}%`;
}
