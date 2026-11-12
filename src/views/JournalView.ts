import { Panel } from "./panel";
import type SamayaPlugin from "../main";

/** The Journal section of the planner (empty for now). */
export class JournalView extends Panel {
  private root: HTMLElement;
  constructor(parentEl: HTMLElement, plugin: SamayaPlugin) {
    super(plugin);
    this.root = parentEl.createDiv("samaya-journal-page");
  }
  onDataUpdated(): void { /* nothing to show yet */ }
}
