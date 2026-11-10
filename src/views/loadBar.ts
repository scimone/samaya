import { fmtDur } from "../util";
import { BUFFER_SHARE, loadLevel } from "../weekplan";

/** "4h planned · 6h recommended" with a fill bar: orange past the buffer, red when over capacity, like the week guide. `share` = the plannable share of the free time. */
export function renderLoadBar(parent: HTMLElement, planned: number, free: number, tip = "", share = BUFFER_SHARE) {
  const level = loadLevel(planned, free, share);
  const wrap = parent.createDiv({ cls: `samaya-loadbar is-${level}` });
  const label = wrap.createDiv({ cls: `samaya-total is-${level}`, text: `${fmtDur(planned)} planned · ${fmtDur(Math.round(free * share))} recommended` });
  label.title = `${tip ? tip + ". " : ""}Plan at most ${Math.round(share * 100)}% of the free time (${fmtDur(Math.round(free * share))}) and keep the rest for what comes up.`;
  const bar = wrap.createDiv({ cls: `samaya-col-bar is-${level}` });
  bar.createDiv("samaya-col-bar-fill").style.width = `${free <= 0 ? (planned > 0 ? 100 : 0) : Math.min(100, (planned / free) * 100)}%`;
  if (free > 0) { const mark = bar.createDiv("samaya-col-bar-mark"); mark.style.left = `${share * 100}%`; mark.title = `${Math.round(share * 100)}% of the free time`; }
}
