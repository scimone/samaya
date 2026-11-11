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
  /** expanded week, timeline and board stacked on one scrolling page: the board drops its headings, the timeline its task chips */
  flow?(): boolean;
  /** flow mode: height of the page the timeline's hours are sized to */
  viewH?(): number;
  /** expanded week: the board has drawn its header (or has none); the layout bar goes right under it when the board is alone */
  placeBar?(root: HTMLElement, head: HTMLElement | null): void;
}
