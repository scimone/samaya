import { Panel } from "./panel";
import type SamayaPlugin from "../main";

export const JOURNAL_BASE_VIEW_TYPE = "samaya-journal";

/** The Journal base's main page: opens the calendar in the right sidebar. */
export class JournalBaseView extends Panel {
  private root: HTMLElement;
  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin);
    this.root = parentEl.createDiv("samaya-journal-page");
    this.root.createEl("h3", { text: "Journal" });
    this.root.createDiv({ cls: "samaya-note", text: "The calendar is in the right sidebar: click a day to open its daily note, a week number for the weekly note, the month, quarter or year for the monthly, quarterly or yearly note." });
    this.root.createEl("button", { text: "Open calendar", cls: "mod-cta" }).onclick = () => { void this.plugin.openJournalCalendar(); };
    // only when this page is really in front (not restored in a background tab at startup)
    window.setTimeout(() => { if (this.root.isShown()) void this.plugin.openJournalDefault(); }, 300);
  }
  onDataUpdated(): void { /* nothing to show from the query */ }
}
