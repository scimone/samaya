import type { App, WorkspaceLeaf } from "obsidian";

/** Where a banner goes: under the header of a pane (`span` false), or in the strip across all panes (`span` true). `leaf` is the pane it is about. */
export interface BarSlot { host: HTMLElement; leaf: WorkspaceLeaf | null; span: boolean }

/**
 * Where the meeting and focus banners go. With one pane showing, under that pane's header. With split panes showing, one strip across all of them:
 * it floats over the top of the editor area (`.mod-root`), which gets padding as tall as the strip. The strip is no flex child of the split: it is taken out of the flow (see styles.css).
 * Switching between the two removes the banners of the other kind, so the callers simply draw into what comes back.
 */
export function bannerSlots(app: App): BarSlot[] {
  const ws = app.workspace; const shown: WorkspaceLeaf[] = [];
  ws.iterateRootLeaves(l => { if (l.view?.containerEl?.isShown()) shown.push(l); });
  const root = document.querySelector<HTMLElement>(".workspace-split.mod-root");
  if (shown.length > 1 && root) {
    let st = root.querySelector<HTMLElement>(":scope > .samaya-bars");
    document.querySelectorAll(".samaya-meet-bar, .samaya-focus-bar").forEach(el => { if (!st?.contains(el)) el.remove(); });
    if (!st) {
      st = createDiv("samaya-bars"); root.prepend(st); root.addClass("samaya-has-bars");
      const box = st; new ResizeObserver(() => root.style.setProperty("--samaya-bars-h", `${box.offsetHeight}px`)).observe(box);
    }
    return [{ host: st, leaf: ws.getMostRecentLeaf(ws.rootSplit), span: true }];
  }
  removeBarStacks();
  return shown.map(l => ({ host: l.view.containerEl, leaf: l, span: false }));
}
/** Take the strip away (one pane left, or plugin unload) together with the banners in it. */
export function removeBarStacks() {
  document.querySelectorAll(".samaya-bars").forEach(el => { const root = el.parentElement; el.remove(); root?.removeClass("samaya-has-bars"); root?.style.removeProperty("--samaya-bars-h"); });
}
