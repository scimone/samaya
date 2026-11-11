/** What the combined Planner view offers the Day and Week panes it hosts. */
export interface PlannerHost {
  /** true while the other pane is the one showing (a hidden pane does not render) */
  hidden(): boolean;
  /** the expanded week timeline: back to the day planner */
  back?(): void;
  /** the expanded week timeline: jump to a day in the day planner */
  openDay?(date: string): void;
  /** expanded week: the week was changed here; the other pane follows */
  weekChanged?(week: string): void;
  /** expanded week: the board sits under the timeline, which already has the week header */
  noHead?(): boolean;
}
