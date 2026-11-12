import { App, PaneType, TFile, WorkspaceLeaf } from "obsidian";

/**
 * Open a note: when it is already open in a tab of the main area (or a pop-out window), that tab is brought to the front
 * instead of opening the same note again. Otherwise it opens like `workspace.getLeaf(where)` would (false = the current tab).
 */
export function openFileSmart(app: App, file: TFile, where: PaneType | boolean = false): void {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateAllLeaves(l => {
    if (found || l.getRoot() === app.workspace.leftSplit || l.getRoot() === app.workspace.rightSplit) return; // sidebars do not count
    if ((l.view as { file?: TFile }).file?.path === file.path) found = l;
  });
  if (found) { void app.workspace.revealLeaf(found); app.workspace.setActiveLeaf(found, { focus: true }); return; }
  void app.workspace.getLeaf(where).openFile(file);
}
