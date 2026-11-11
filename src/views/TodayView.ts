import { ItemView, WorkspaceLeaf } from "obsidian";

export const TODAY_VIEW_TYPE = "samaya-today";

/** The old right-sidebar view. Plan my day and Plan my week show their timeline / This week column in the planner now; this only closes a leftover sidebar tab from an earlier layout. */
export class TodayView extends ItemView {
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return TODAY_VIEW_TYPE; }
  getDisplayText() { return "Today"; }
  getIcon() { return "calendar-clock"; }
  onOpen() { this.leaf.detach(); return Promise.resolve(); }
}
