/** What the combined Planner view offers the Day and Week panes it hosts. */
export interface PlannerHost {
  /** true while the other pane is the one showing (a hidden pane does not render) */
  hidden(): boolean;
}
