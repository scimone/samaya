import { Component } from "obsidian";
import type SamayaPlugin from "../main";

/** Common base of the planner's panes (day, week board, week timeline): the app, and the planner options from the settings. */
export abstract class PlannerPane extends Component {
  readonly app: SamayaPlugin["app"];
  constructor(protected plugin: SamayaPlugin) { super(); this.app = plugin.app; }
  /** The planner options: same keys the Bases view used to have. */
  protected get config() {
    const s = this.plugin.settings;
    return { get: (k: string): unknown => k === "showWeekends" ? s.plannerWeekends : k === "showEvents" ? s.plannerShowEvents : undefined };
  }
  abstract onDataUpdated(): void;
}
