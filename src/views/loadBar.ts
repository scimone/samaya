import { fmtDur } from "../util";
import { BUFFER_SHARE, loadLevel } from "../weekplan";
import { renderCapBar } from "./capBar";

/** "2h left to plan" (recommended - allocated) over the capacity bar: meetings and tasks in their colours, the whole bar orange past the buffer and red when over capacity. `share` = the plannable share of the free time. */
export const leftLabel = (left: number, past = false) => left >= 0 ? `${fmtDur(left)} ${past ? "unplanned" : "left to plan"}` : `${fmtDur(-left)} over`; // (a day or week that has passed: nothing is left to plan any more)

export function renderLoadBar(parent: HTMLElement, planned: number, free: number, tip = "", share = BUFFER_SHARE, meetings = 0, past = false) {
  const level = loadLevel(planned, free, share);
  const wrap = parent.createDiv({ cls: `samaya-loadbar is-${level}` });
  const label = wrap.createDiv({ cls: `samaya-total is-${level}`, text: leftLabel(Math.round(free * share) - planned, past) });
  label.title = `${tip ? tip + ". " : ""}Allocated = ${fmtDur(planned)} tasks + ${fmtDur(meetings)} meetings. Plan at most ${Math.round(share * 100)}% of the free time (${fmtDur(Math.round(free * share))}) and keep the rest for what comes up.`;
  renderCapBar(wrap, { tasks: planned, meetings, free, share });
}
