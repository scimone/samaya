import { Component, TFile } from "obsidian";
import type SamayaPlugin from "../main";
import { prefixOf } from "../model";

/** A view shown inside the planner (tasks, tickets, projects, meetings, journal): feeds itself from the notes of a folder and redraws when they change. */
export abstract class Panel extends Component {
  readonly app: SamayaPlugin["app"];
  constructor(protected plugin: SamayaPlugin, private folder: () => string = () => "", protected opts: Record<string, unknown> = {}) { super(); this.app = plugin.app; }
  get config() { return { get: (k: string): unknown => this.opts[k] }; }
  /** The notes of the panel's folder (every note when it has none). */
  get data(): { data: { file: TFile }[] } {
    const prefix = this.folder() ? prefixOf(this.folder()) : "";
    return { data: this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(file => ({ file })) };
  }
  onload() {
    let tm = 0; const touched = () => { window.clearTimeout(tm); tm = window.setTimeout(() => this.onDataUpdated(), 150); };
    const { vault, metadataCache: mc } = this.app;
    this.registerEvent(mc.on("changed", touched)); this.registerEvent(mc.on("deleted", touched));
    this.registerEvent(vault.on("create", touched)); this.registerEvent(vault.on("rename", touched)); this.registerEvent(vault.on("delete", touched));
    this.register(() => window.clearTimeout(tm));
    this.onDataUpdated();
  }
  abstract onDataUpdated(): void;
}
