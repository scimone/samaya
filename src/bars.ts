import type { App, WorkspaceLeaf } from "obsidian";

/** Where a banner goes: under the header of a pane (`span` false), or in the strip across all panes (`span` true). `leaf` is the pane it is about. */
export interface BarSlot { host: HTMLElement; leaf: WorkspaceLeaf | null; span: boolean }

/**
 * Where the meeting and focus banners go. With one pane showing, under that pane's header (the breadcrumb). With panes side by side, one strip across all of them
 * at the same height: between their headers and their notes. A pane clips what is inside it, so the strip floats in the editor area (`.mod-root`) over a gap that is
 * made in every pane just under its header; `layoutStrip` keeps strip and gaps in step. Switching between the two removes what the other kind drew,
 * so the callers simply draw into what comes back.
 */
export function bannerSlots(app: App): BarSlot[] {
  const ws = app.workspace; const shown: WorkspaceLeaf[] = [];
  ws.iterateRootLeaves(l => { if (l.view?.containerEl?.isShown()) shown.push(l); });
  const root = document.querySelector<HTMLElement>(".workspace-split.mod-root");
  const hosts = shown.map(l => l.view.containerEl);
  if (shown.length > 1 && root && sideBySide(hosts)) {
    let st = root.querySelector<HTMLElement>(":scope > .samaya-bars");
    document.querySelectorAll(".samaya-meet-bar, .samaya-focus-bar").forEach(el => { if (!st?.contains(el)) el.remove(); });
    if (!st) { st = createDiv("samaya-bars"); root.prepend(st); }
    watch(root, st, hosts);
    return [{ host: st, leaf: ws.getMostRecentLeaf(ws.rootSplit), span: true }];
  }
  removeBarStacks();
  return shown.map(l => ({ host: l.view.containerEl, leaf: l, span: false }));
}

/** Panes in a row (same top edge), not stacked on top of each other. */
export function sideBySide(hosts: HTMLElement[]): boolean {
  const tops = hosts.map(h => h.getBoundingClientRect().top);
  return Math.max(...tops) - Math.min(...tops) < 3;
}

/**
 * Put the strip over the gaps: as wide as all panes together, as high as the lowest pane header ends, and give every pane a gap that fills
 * from the end of its own header down to the bottom of the strip. Measures first, writes after.
 */
export function layoutStrip(root: HTMLElement, st: HTMLElement, hosts: HTMLElement[]) {
  const rr = root.getBoundingClientRect();
  const rows = hosts.map(host => {
    const hd = host.querySelector<HTMLElement>(":scope > .view-header"); const r = host.getBoundingClientRect();
    return { host, hd, left: r.left, right: r.right, bottom: hd && hd.offsetHeight ? hd.getBoundingClientRect().bottom : r.top };
  });
  const top = Math.max(...rows.map(r => r.bottom)), left = Math.min(...rows.map(r => r.left)), right = Math.max(...rows.map(r => r.right));
  st.style.left = `${left - rr.left}px`; st.style.width = `${right - left}px`; // the width first: the strip's height depends on it
  const h = st.offsetHeight;
  for (const r of rows) {
    let gap = r.host.querySelector<HTMLElement>(":scope > .samaya-bar-gap");
    if (!gap) { gap = createDiv("samaya-bar-gap"); if (r.hd) r.hd.after(gap); else r.host.prepend(gap); }
    gap.style.height = `${top - r.bottom + h}px`;
  }
  st.style.top = `${top - rr.top}px`;
}

let obs: ResizeObserver | null = null;
/** Re-lay the strip whenever the editor area, a pane or the strip changes size (window, splitter, a bar coming or going). */
function watch(root: HTMLElement, st: HTMLElement, hosts: HTMLElement[]) {
  obs?.disconnect(); obs = new ResizeObserver(() => layoutStrip(root, st, hosts));
  obs.observe(root); obs.observe(st); hosts.forEach(h => obs!.observe(h));
  layoutStrip(root, st, hosts);
}

/** Take the strip and the gaps away (one pane left, or plugin unload) together with the banners in it. */
export function removeBarStacks() {
  obs?.disconnect(); obs = null;
  document.querySelectorAll(".samaya-bars, .samaya-bar-gap").forEach(el => el.remove());
}
