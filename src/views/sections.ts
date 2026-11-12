import type SamayaPlugin from "../main";
import { Panel } from "./panel";
import { BacklogView } from "./BacklogView";
import { BacklogBucketsView } from "./BacklogBucketsView";
import { KanbanView } from "./KanbanView";
import { GanttView } from "./GanttView";
import { MeetingsView } from "./MeetingsView";
import { JournalBaseView } from "./JournalBaseView";

export interface Tab { name: string; make: (el: HTMLElement, plugin: SamayaPlugin) => Panel; }

/** What each planner section (side rail entry) shows: one panel, or several behind a small tab switch. */
export const SECTION_TABS: Record<string, Tab[]> = {
  tasks: [{ name: "Backlog", make: (el, p) => new BacklogView(el, p) }, { name: "By date", make: (el, p) => new BacklogBucketsView(el, p) }],
  journal: [{ name: "Calendar", make: (el, p) => new JournalBaseView(el, p) }],
  meetings: [{ name: "Meetings", make: (el, p) => new MeetingsView(el, p) }],
  projects: [{ name: "Gantt", make: (el, p) => new GanttView(el, p) }],
  tickets: [{ name: "Board", make: (el, p) => new KanbanView(el, p) }],
};
