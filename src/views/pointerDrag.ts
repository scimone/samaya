/**
 * Follow a pointer drag on `window`: `move` for every move, `end(cancelled)` once, when it is released (false) or the browser cancels it (true: touch
 * interrupted, window lost focus). Both always clean up the listeners, so a drag can never be left running.
 */
export function trackPointer(move: (e: PointerEvent) => void, end: (cancelled: boolean) => void): void {
  const finish = (cancelled: boolean) => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel);
    end(cancelled);
  };
  const up = () => finish(false), cancel = () => finish(true);
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel);
}
