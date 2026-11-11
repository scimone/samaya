import { fmtDur } from "../util";
import { BUFFER_SHARE, loadLevel } from "../weekplan";
import { renderCapBar } from "./capBar";

/** "4h allocated (tasks + meetings) · 6h recommended" over the capacity bar: meetings and tasks in their colours, the whole bar orange past the buffer and red when over capacity. `share` = the plannable share of the free time. */
export function renderLoadBar(parent: HTMLElement, planned: number, free: number, tip = "", share = BUFFER_SHARE, meetings = 0) {
  const level = loadLevel(planned, free, share);
  const wrap = parent.createDiv({ cls: `samaya-loadbar is-${level}` });
  const label = wrap.createDiv({ cls: `samaya-total is-${level}`, text: `${fmtDur(planned + meetings)} allocated · ${fmtDur(meetings + Math.round(free * share))} recommended` });
  label.title = `${tip ? tip + ". " : ""}Allocated = ${fmtDur(planned)} tasks + ${fmtDur(meetings)} meetings. Plan at most ${Math.round(share * 100)}% of the free time (${fmtDur(Math.round(free * share))}) and keep the rest for what comes up.`;
  renderCapBar(wrap, { tasks: planned, meetings, free, share });
}
