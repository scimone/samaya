import { App, PaneType, TFile, WorkspaceLeaf } from "obsidian";

/** Path of the note a tab shows; falls back to the saved state for tabs whose view is not loaded yet (deferred after a restart). */
export function leafPath(l: WorkspaceLeaf): string | undefined {
  const live = (l.view as { file?: TFile }).file?.path; if (live) return live;
  const f = l.getViewState().state?.file; return typeof f === "string" ? f : undefined;
}

/**
 * Open a note: when it is already open in a tab of the main area (or a pop-out window), that tab is brought to the front
 * instead of opening the same note again. Otherwise it opens like `workspace.getLeaf(where)` would (false = the current tab).
 */
export function openFileSmart(app: App, file: TFile, where: PaneType | boolean = false): void {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateAllLeaves(l => {
    if (found || l.getRoot() === app.workspace.leftSplit || l.getRoot() === app.workspace.rightSplit) return; // sidebars do not count
    if (leafPath(l) === file.path) found = l;
  });
  if (found) { void app.workspace.revealLeaf(found); app.workspace.setActiveLeaf(found, { focus: true }); return; }
  void app.workspace.getLeaf(where).openFile(file);
}

/** Open a note in a split beside the current view; one that is already open in a tab is brought to the front instead. */
export function openFileBeside(app: App, file: TFile): void {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateAllLeaves(l => { if (!found && l.getRoot() !== app.workspace.leftSplit && l.getRoot() !== app.workspace.rightSplit && leafPath(l) === file.path) found = l; });
  if (found) { void app.workspace.revealLeaf(found); app.workspace.setActiveLeaf(found, { focus: true }); return; }
  void app.workspace.getLeaf("split", "vertical").openFile(file);
}
