import type SamayaPlugin from "../main";
import { Panel } from "./panel";
import { TasksView } from "./TasksView";
import { KanbanView } from "./KanbanView";
import { GanttView } from "./GanttView";
import { JournalView } from "./JournalView";
import { MeetingsView } from "./MeetingsView";

export interface Tab { name: string; make: (el: HTMLElement, plugin: SamayaPlugin) => Panel; }

/** What each planner section (side rail entry) shows: one panel, or several behind a small tab switch. */
export const SECTION_TABS: Record<string, Tab[]> = {
  tasks: [{ name: "Tasks", make: (el, p) => new TasksView(el, p) }],
  journal: [{ name: "Journal", make: (el, p) => new JournalView(el, p) }],
  meetings: [{ name: "Meetings", make: (el, p) => new MeetingsView(el, p) }],
  projects: [{ name: "Gantt", make: (el, p) => new GanttView(el, p) }],
  tickets: [{ name: "Board", make: (el, p) => new KanbanView(el, p) }],
};
