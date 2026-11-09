// Pointer-based drag & drop. Native HTML5 DnD gives no control over the drag image, hit-testing or
// auto-scrolling and feels sluggish; this keeps a ghost glued to the pointer, shows live previews
// and scrolls containers when you drag near their edge.

export interface DropInfo { path: string; x: number; y: number; grabY: number; /** dragged from a timeline block (not from a card) */ fromTimeline: boolean; /** which segment of a split task is dragged (timeline blocks of split tasks only) */ seg: number | null; }
export interface DropHandlers { over?(i: DropInfo): void; leave?(): void; drop(i: DropInfo): void; }
interface Target { el: HTMLElement; h: DropHandlers; }

const NO_DRAG = "input,button,textarea,select,.samaya-nodrag,.samaya-resize,.samaya-block-state";
const EDGE = 56, MAX_SPEED = 22;

function scrollParent(el: Element | null): HTMLElement | null {
  while (el && el instanceof HTMLElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
    el = el.parentElement;
  }
  return null;
}

export class DndScope {
  /** every live scope: drops may land in another view (e.g. the sidebar) */
  private static all = new Set<DndScope>();
  private targets: Target[] = [];
  active = false;
  onIdle?: () => void;
  constructor() { DndScope.all.add(this); }
  dispose() { DndScope.all.delete(this); this.targets = []; }

  clear() { this.targets = []; }
  target(el: HTMLElement, h: DropHandlers) { this.targets.push({ el, h }); }

  /** `grabY`: fixed pointer offset to report; default = offset of the pointer inside the dragged element. */
  draggable(el: HTMLElement, path: string, o: { grabY?: number; onStart?: () => void } = {}) {
    el.addEventListener("pointerdown", e => this.begin(e, el, path, o));
  }

  private hit(x: number, y: number): Target | null {
    let best: Target | null = null, bestArea = Infinity;
    for (const t of Array.from(DndScope.all).flatMap(sc => sc.targets)) {
      if (!t.el.isConnected) continue;
      const r = t.el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const a = r.width * r.height; if (a < bestArea) { best = t; bestArea = a; }
    }
    return best;
  }

  private begin(e: PointerEvent, el: HTMLElement, path: string, o: { grabY?: number; onStart?: () => void }) {
    if (this.active || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest(NO_DRAG)) return;
    const touch = e.pointerType === "touch";
    const sx = e.clientX, sy = e.clientY, rect = el.getBoundingClientRect();
    const offX = sx - rect.left, offY = sy - rect.top;
    let armed = !touch, started = false, last = e, hover: Target | null = null;
    let ghost: HTMLElement | null = null, timer = 0, scrollTimer = 0;
    const holdTimer = touch ? window.setTimeout(() => { armed = true; }, 220) : 0;
    const info = (ev: PointerEvent): DropInfo => ({ path, x: ev.clientX, y: ev.clientY, grabY: o.grabY ?? offY, fromTimeline: el.classList.contains("samaya-block"), seg: el.dataset.seg !== undefined ? Number(el.dataset.seg) : null });
    const noScroll = (ev: Event) => { if (started) ev.preventDefault(); };
    const noSelect = (ev: Event) => ev.preventDefault();

    const update = (ev: PointerEvent) => {
      if (!ghost) return;
      ghost.style.transform = `translate(${ev.clientX - offX}px, ${ev.clientY - offY}px)`;
      const t = this.hit(ev.clientX, ev.clientY);
      if (t !== hover) { hover?.h.leave?.(); hover = t; }
      t?.h.over?.(info(ev));
    };
    const autoscroll = () => {
      const under = document.elementFromPoint(last.clientX, last.clientY);
      const sp = scrollParent(under); if (!sp) return;
      const r = sp.getBoundingClientRect(); let dy = 0;
      if (last.clientY < r.top + EDGE) dy = -MAX_SPEED * Math.min(1, (r.top + EDGE - last.clientY) / EDGE);
      else if (last.clientY > r.bottom - EDGE) dy = MAX_SPEED * Math.min(1, (last.clientY - (r.bottom - EDGE)) / EDGE);
      if (dy) { sp.scrollTop += dy; update(last); }
    };
    const start = () => {
      started = true; this.active = true; o.onStart?.();
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.addClass("samaya-ghost"); ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`;
      document.body.appendChild(ghost); el.addClass("is-dragging"); document.body.addClass("samaya-dragging");
      window.addEventListener("touchmove", noScroll, { passive: false }); window.addEventListener("selectstart", noSelect);
      scrollTimer = window.setInterval(autoscroll, 30);
    };
    const finish = (ev: PointerEvent | null, drop: boolean) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel);
      window.clearTimeout(holdTimer); window.clearInterval(scrollTimer); window.clearTimeout(timer);
      if (!started) return;
      window.removeEventListener("touchmove", noScroll); window.removeEventListener("selectstart", noSelect);
      const t = ev ? this.hit(ev.clientX, ev.clientY) : null;
      hover?.h.leave?.();
      ghost?.remove(); el.removeClass("is-dragging"); document.body.removeClass("samaya-dragging");
      // a drag must not also count as a click on the element
      const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
      this.active = false;
      if (drop && t && ev) t.h.drop(info(ev));
      window.setTimeout(() => this.onIdle?.(), 0);
    };
    const move = (ev: PointerEvent) => {
      last = ev;
      if (!started) {
        const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
        if (touch && !armed) { if (d > 8) finish(null, false); return; }
        if (d < 5) return; start();
      }
      update(ev);
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = () => finish(null, false);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel);
  }
}
