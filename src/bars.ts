import type { WorkspaceLeaf } from "obsidian";

/**
 * The strip for the meeting and focus banners: one bar across the whole editor area (all split panes under it), not inside a single pane.
 * It floats on top of the editor area, which gets padding as tall as the strip so nothing hides under it.
 */
export function barStack(leaf: WorkspaceLeaf | null): HTMLElement | null {
  const root = leaf?.view?.containerEl?.closest<HTMLElement>(".mod-root"); if (!root) return null;
  let st = root.querySelector<HTMLElement>(":scope > .samaya-bars");
  if (!st) {
    st = createDiv("samaya-bars"); root.prepend(st); root.addClass("samaya-has-bars");
    const box = st; new ResizeObserver(() => root.style.setProperty("--samaya-bars-h", `${box.offsetHeight}px`)).observe(box);
  }
  return st;
}
/** Take the strip away (plugin unload). */
export function removeBarStacks() {
  document.querySelectorAll(".samaya-bars").forEach(el => { const root = el.parentElement; el.remove(); root?.removeClass("samaya-has-bars"); root?.style.removeProperty("--samaya-bars-h"); });
}
