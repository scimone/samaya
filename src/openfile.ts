import { App, ItemView, PaneType, TFile, WorkspaceLeaf } from "obsidian";

/** Path of the note a tab shows; falls back to the saved state for tabs whose view is not loaded yet (deferred after a restart). */
export function leafPath(l: WorkspaceLeaf): string | undefined {
  const live = (l.view as { file?: TFile }).file?.path; if (live) return live;
  const f = l.getViewState().state?.file; return typeof f === "string" ? f : undefined;
}

/** The pane Samaya opens notes in (beside the view the click came from), for as long as it is there. */
let side: WorkspaceLeaf | null = null;
let waitPath = "";
/** What the opener needs from the plugin: the task in focus (it always opens in a full page), and dressing the side pane's note (bars, hidden heading). */
export const hooks = { focusPath: (): string | undefined => undefined, dress: (): Promise<void> => Promise.resolve() };

/**
 * Open a note in the side view: a split beside the Samaya page you are on. Once that pane exists every note opens in it, replacing what it showed
 * (no new tab each time). If the pane was closed, the next note makes a new one. The `where` argument is kept for the callers and not used.
 */
export function openFileSmart(app: App, file: TFile, _where?: PaneType | boolean): void { void openNote(app, file); }
export const openFileBeside = (app: App, file: TFile): void => openFileSmart(app, file);

export async function openNote(app: App, file: TFile): Promise<void> {
  if (hooks.focusPath() === file.path) { await openFull(app, file); return; } // the task in focus: a full page
  const ws = app.workspace; let leaf: WorkspaceLeaf | null = null;
  ws.iterateRootLeaves(l => { if (l === side && !l.view.getViewType().startsWith("samaya-")) leaf = l; }); // still there, and not one of our own pages
  if (!leaf) {
    const active = ws.getActiveViewOfType(ItemView)?.leaf; const base = active && active.getRoot() === ws.rootSplit ? active : ws.getMostRecentLeaf(ws.rootSplit);
    leaf = base ? ws.createLeafBySplit(base, "vertical") : ws.getLeaf("tab"); side = leaf;
    narrowSide(leaf); rememberSide(app, leaf);
  }
  if (leafPath(leaf) !== file.path) {
    // hide the note until its bars and hidden headings are in place (see renderSideBars), so it does not show half dressed first
    const pane = leaf.view.containerEl.closest<HTMLElement>(".workspace-leaf"); pane?.addClass("samaya-side-wait"); waitPath = file.path;
    window.setTimeout(() => pane?.removeClass("samaya-side-wait"), 1200); // never stay hidden
    await leaf.openFile(file);
  }
  void hooks.dress(); // bars at once, not behind the slower pass over every open note
  void ws.revealLeaf(leaf); ws.setActiveLeaf(leaf, { focus: true });
}

/** The side pane, when it is open. */
export function sideLeaf(app: App): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateRootLeaves(l => { if (l === side) found = l; });
  return found;
}
/** Close the side pane. */
export function closeSide(app: App): void { const l = sideLeaf(app); side = null; l?.detach(); app.saveLocalStorage(SIDE_KEY, null); }

const SIDE_KEY = "samaya-side-leaf";
/** Leaf ids are saved in the workspace layout, so a side pane left open when Obsidian quit can be recognised on the next start. */
function rememberSide(app: App, leaf: WorkspaceLeaf): void { const id = (leaf as unknown as { id?: string }).id; if (id) app.saveLocalStorage(SIDE_KEY, id); }
/** On start, close the side pane Samaya left open when Obsidian quit (found by its saved leaf id) so it does not come back. Nothing else is touched, and nothing is closed while quitting. */
export function setupSideCleanup(app: App): void {
  app.workspace.onLayoutReady(() => {
    const id = app.loadLocalStorage(SIDE_KEY) as string | null; if (!id) return;
    app.workspace.iterateRootLeaves(l => { if ((l as unknown as { id?: string }).id === id && !l.view.getViewType().startsWith("samaya-")) l.detach(); });
    app.saveLocalStorage(SIDE_KEY, null);
  });
}
/** Show a note in a full page: the tab that already shows it, else a new tab. A side pane that shows the same note closes. */
export async function openFull(app: App, file: TFile): Promise<void> {
  const l = sideLeaf(app); if (l && leafPath(l) === file.path) closeSide(app);
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateRootLeaves(x => { if (!found && leafPath(x) === file.path) found = x; });
  const leaf: WorkspaceLeaf = found ?? app.workspace.getLeaf("tab");
  if (!found) await leaf.openFile(file);
  void app.workspace.revealLeaf(leaf); app.workspace.setActiveLeaf(leaf, { focus: true });
}
/** Close the side pane and show its note in a full page. */
export async function expandSide(app: App): Promise<void> {
  const l = sideLeaf(app); const file = l ? app.vault.getAbstractFileByPath(leafPath(l) ?? "") : null;
  closeSide(app); if (file instanceof TFile) await openFull(app, file);
}

/** The side pane shows its note now (called once the note is dressed), if it is the one that was waited for. */
export function sideWaitDone(leaf: WorkspaceLeaf | null): void {
  if (!leaf || !waitPath || leafPath(leaf) !== waitPath) return;
  waitPath = ""; leaf.view.containerEl.closest(".workspace-leaf")?.removeClass("samaya-side-wait");
}

/** A new side pane starts a bit narrower than the page it opened beside (42 : 58 instead of half and half). Obsidian's own, undocumented call; skipped when it is not there or the row has more than two panes. */
function narrowSide(leaf: WorkspaceLeaf) {
  type Item = { setDimension?: (pct: number) => void; parent?: { children?: Item[] } };
  const mine = leaf.parent as unknown as Item; const row = mine.parent?.children;
  if (!row || row.length !== 2 || !row.every(i => typeof i.setDimension === "function")) return;
  row.forEach(i => i.setDimension!(i === mine ? 42 : 58));
}
