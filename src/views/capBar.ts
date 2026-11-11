import { fmtDur } from "../util";
import { BUFFER_SHARE, capBarShape, loadLevel } from "../weekplan";

/** The capacity bar used everywhere: the meetings (meeting colour) then the tasks (task colour) over the plannable time, with a mark where the recommended time ends.
 *  Past that mark the whole bar turns orange, over capacity red (CSS, by the `is-tight` / `is-over` class). */
export function renderCapBar(parent: HTMLElement, o: { tasks: number; meetings: number; free: number; share?: number; cls?: string; markTip?: string }): HTMLElement {
  const share = o.share ?? BUFFER_SHARE; const lvl = loadLevel(o.tasks, o.free, share); const g = capBarShape(o.tasks, o.meetings, o.free, share);
  const bar = parent.createDiv({ cls: `samaya-col-bar is-${lvl}` + (o.cls ? " " + o.cls : "") });
  const seg = (kind: "meet" | "task", pct: number, tip: string) => { if (pct <= 0) return; const e = bar.createDiv(`samaya-col-bar-fill is-${kind}`); e.style.width = `${pct}%`; e.title = tip; };
  seg("meet", g.meet, `Meetings: ${fmtDur(o.meetings)}`); seg("task", g.task, `Tasks: ${fmtDur(o.tasks)}`);
  if (g.mark !== null) { const m = bar.createDiv("samaya-col-bar-mark"); m.style.left = `${g.mark}%`; m.title = o.markTip ?? `${Math.round(share * 100)}% of the free time`; }
  return bar;
}
