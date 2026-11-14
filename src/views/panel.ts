import { Component, TFile } from "obsidian";
import type SamayaPlugin from "../main";

/** A view shown inside the planner (tasks, tickets, projects, meetings, journal): feeds itself from the notes of a folder and redraws when they change. */
export abstract class Panel extends Component {
  readonly app: SamayaPlugin["app"];
  constructor(protected plugin: SamayaPlugin, private prefix: () => string = () => "", protected opts: Record<string, unknown> = {}) { super(); this.app = plugin.app; }
  get config() { return { get: (k: string): unknown => this.opts[k] }; }
  /** The notes of the panel's folder (every note when its prefix is empty). The prefix is a literal vault path prefix with trailing slash, never a pattern. */
  get data(): { data: { file: TFile }[] } {
    const prefix = this.prefix();
    return { data: this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix)).map(file => ({ file })) };
  }
  /** The element the panel draws into: while it is not on screen (another tab, another section) changes only mark the panel stale and it redraws when shown again. */
  protected visibleEl(): HTMLElement | null { return null; }
  private stale = false;
  onload() {
    const el = this.visibleEl();
    if (el) {
      const ro = new ResizeObserver(() => { if (this.stale && el.isShown()) { this.stale = false; this.onDataUpdated(); } });
      ro.observe(el); this.register(() => ro.disconnect());
    }
    let tm = 0;
    const touched = () => { window.clearTimeout(tm); tm = window.setTimeout(() => { if (el && !el.isShown()) this.stale = true; else this.onDataUpdated(); }, 150); };
    const { vault, metadataCache: mc } = this.app;
    this.registerEvent(mc.on("changed", touched)); this.registerEvent(mc.on("deleted", touched));
    this.registerEvent(vault.on("create", touched)); this.registerEvent(vault.on("rename", touched)); this.registerEvent(vault.on("delete", touched));
    this.register(() => window.clearTimeout(tm));
    this.onDataUpdated();
  }
  abstract onDataUpdated(): void;
}
