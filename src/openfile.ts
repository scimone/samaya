import { App, ItemView, PaneType, TFile, WorkspaceLeaf } from "obsidian";

/** Path of the note a tab shows; falls back to the saved state for tabs whose view is not loaded yet (deferred after a restart). */
export function leafPath(l: WorkspaceLeaf): string | undefined {
  const live = (l.view as { file?: TFile }).file?.path; if (live) return live;
  const f = l.getViewState().state?.file; return typeof f === "string" ? f : undefined;
}

/** The pane Samaya opens notes in (beside the view the click came from), for as long as it is there. */
let side: WorkspaceLeaf | null = null;

/**
 * Open a note in the side view: a split beside the Samaya page you are on. Once that pane exists every note opens in it, replacing what it showed
 * (no new tab each time). If the pane was closed, the next note makes a new one. The `where` argument is kept for the callers and not used.
 */
export function openFileSmart(app: App, file: TFile, _where?: PaneType | boolean): void { void openNote(app, file); }
export const openFileBeside = (app: App, file: TFile): void => openFileSmart(app, file);

export async function openNote(app: App, file: TFile): Promise<void> {
  const ws = app.workspace; let leaf: WorkspaceLeaf | null = null;
  ws.iterateRootLeaves(l => { if (l === side && !l.view.getViewType().startsWith("samaya-")) leaf = l; }); // still there, and not one of our own pages
  if (!leaf) {
    const active = ws.getActiveViewOfType(ItemView)?.leaf; const base = active && active.getRoot() === ws.rootSplit ? active : ws.getMostRecentLeaf(ws.rootSplit);
    leaf = base ? ws.createLeafBySplit(base, "vertical") : ws.getLeaf("tab"); side = leaf;
  }
  if (leafPath(leaf) !== file.path) await leaf.openFile(file);
  void ws.revealLeaf(leaf); ws.setActiveLeaf(leaf, { focus: true });
}

/** The side pane, when it is open. */
export function sideLeaf(app: App): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateRootLeaves(l => { if (l === side) found = l; });
  return found;
}
/** Close the side pane. */
export function closeSide(app: App): void { const l = sideLeaf(app); side = null; l?.detach(); }
/** Close the side pane and show its note in a full page: the tab that already shows it, else a new one. */
export async function expandSide(app: App): Promise<void> {
  const l = sideLeaf(app); const file = l ? app.vault.getAbstractFileByPath(leafPath(l) ?? "") : null;
  closeSide(app); if (!(file instanceof TFile)) return;
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateRootLeaves(x => { if (!found && leafPath(x) === file.path) found = x; });
  const leaf: WorkspaceLeaf = found ?? app.workspace.getLeaf("tab");
  if (!found) await leaf.openFile(file);
  void app.workspace.revealLeaf(leaf); app.workspace.setActiveLeaf(leaf, { focus: true });
}
