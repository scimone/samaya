import type { DndScope } from "../dnd";

/**
 * Coalesces redraw requests for a view: a burst of updates draws once (after 30 ms), a hidden view does not draw, and nothing is redrawn in the middle
 * of a drag (the request is kept and runs when the drag ends, see DndScope.onIdle).
 */
export class Scheduler {
  private timer = 0; private pending = false;
  constructor(private scope: DndScope, private run: () => void, private hidden: () => boolean = () => false) {
    scope.onIdle = () => { if (this.pending) { this.pending = false; this.request(); } };
  }
  request(): void {
    if (this.hidden()) return;
    if (this.scope.active && !document.querySelector(".samaya-ghost")) this.scope.active = false; // a drag that never ended must not freeze the view
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(this.run, 30);
  }
  /** A draw that finds a drag running (it waited for something asynchronous) asks to be repeated afterwards. */
  defer(): void { this.pending = true; }
  cancel(): void { window.clearTimeout(this.timer); }
}
