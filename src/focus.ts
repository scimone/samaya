import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type SamayaPlugin from "./main";
import { patchTask, readTask, readTicket, ticketPathOf } from "./model";
import { renderSubtasks } from "./views/common";
import { fmtDur, fmtHm } from "./util";

export const FOCUS_VIEW_TYPE = "samaya-focus";

export interface FocusState { path: string; accumulatedMs: number; startedAt: number | null; }

const clock = (ms: number): string => {
  const sec = Math.floor(ms / 1000); const f = (n: number) => String(n).padStart(2, "0");
  return `${f(Math.floor(sec / 3600))}:${f(Math.floor(sec / 60) % 60)}:${f(sec % 60)}`;
};

export class FocusManager {
  state: FocusState | null = null;
  private statusEl: HTMLElement | null = null;
  constructor(private plugin: SamayaPlugin) {}

  init(statusEl: HTMLElement, saved: FocusState | null) {
    this.statusEl = statusEl; this.state = saved;
    statusEl.addClass("samaya-status");
    statusEl.addEventListener("click", () => { void this.openView(); });
    this.plugin.registerInterval(window.setInterval(() => this.renderStatus(), 1000));
    this.renderStatus();
  }
  /** Session time of the running / paused focus. */
  sessionMs(): number { const s = this.state; return s ? s.accumulatedMs + (s.startedAt ? Date.now() - s.startedAt : 0) : 0; }
  get file(): TFile | null { const f = this.state && this.plugin.app.vault.getAbstractFileByPath(this.state.path); return f instanceof TFile ? f : null; }

  private async persist() { this.plugin.data.focus = this.state; await this.plugin.saveData(this.plugin.data); }
  private renderStatus() {
    const el = this.statusEl; if (!el) return;
    if (!this.state) { el.setText(""); el.hide(); return; }
    el.show(); el.toggleClass("is-break", !this.state.startedAt); el.setText(`${this.state.startedAt ? "Focus" : "Paused"} · ${this.file?.basename ?? ""} · ${clock(this.sessionMs())}`);
  }
  private refreshViews() {
    this.renderStatus();
    this.plugin.app.workspace.getLeavesOfType(FOCUS_VIEW_TYPE).forEach(l => { if (l.view instanceof FocusView) l.view.render(); });
  }

  async start(file: TFile) {
    if (this.state && this.state.path !== file.path) await this.stop(false);
    if (!this.state) this.state = { path: file.path, accumulatedMs: 0, startedAt: Date.now() };
    else if (!this.state.startedAt) this.state.startedAt = Date.now();
    await this.persist();
    // task note next to the focus panel, so you can write notes while working
    const app = this.plugin.app;
    let leaf: WorkspaceLeaf | null = null;
    app.workspace.iterateAllLeaves(l => { if (!leaf && l.view instanceof Object && (l.view as { file?: TFile }).file?.path === file.path && l.getRoot() === app.workspace.rootSplit) leaf = l; });
    if (!leaf) { leaf = app.workspace.getLeaf("tab"); await leaf.openFile(file); }
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await this.openView();
    this.refreshViews();
  }
  async openView() {
    const ws = this.plugin.app.workspace;
    let leaf = ws.getLeavesOfType(FOCUS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false) ?? ws.getLeaf("split", "vertical");
      await leaf.setViewState({ type: FOCUS_VIEW_TYPE, active: false });
    }
    await ws.revealLeaf(leaf);
  }
  async pause() { const s = this.state; if (!s || !s.startedAt) return; s.accumulatedMs += Date.now() - s.startedAt; s.startedAt = null; await this.persist(); this.refreshViews(); }
  async resume() { const s = this.state; if (!s || s.startedAt) return; s.startedAt = Date.now(); await this.persist(); this.refreshViews(); }
  /** Stop, add the session's minutes to the task's `actual`, optionally complete it. */
  async stop(markDone: boolean) {
    const s = this.state; if (!s) return;
    await this.pause();
    const minutes = Math.round(this.sessionMs() / 60000); const file = this.file;
    this.state = null; await this.persist();
    this.plugin.app.workspace.detachLeavesOfType(FOCUS_VIEW_TYPE);
    this.renderStatus();
    if (file) {
      const t = readTask(this.plugin.app, file);
      await patchTask(this.plugin.app, file, {
        actual: t.actual + minutes || undefined,
        ...(markDone ? { status: "done", completed: new Date().toISOString().slice(0, 10) } : {}),
      });
      new Notice(`Logged ${fmtDur(minutes)} on "${file.basename}"${markDone ? " - done" : ""}`);
    }
  }
}

type IconKind = "pause" | "play" | "check";
function drawIcon(parent: HTMLElement, kind: IconKind) {
  const svg = parent.createSvg("svg", { attr: { viewBox: "0 0 24 24", width: "26", height: "26", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } });
  if (kind === "pause") {
    svg.createSvg("rect", { attr: { x: "6", y: "5", width: "4", height: "14", rx: "1", fill: "currentColor" } });
    svg.createSvg("rect", { attr: { x: "14", y: "5", width: "4", height: "14", rx: "1", fill: "currentColor" } });
  } else if (kind === "play") {
    svg.createSvg("path", { attr: { d: "M8 5v14l11-7z", fill: "currentColor" } });
  } else { // checked checkbox
    svg.createSvg("rect", { attr: { x: "3", y: "3", width: "18", height: "18", rx: "3" } });
    svg.createSvg("path", { attr: { d: "m8 12 3 3 5-6" } });
  }
}

export class FocusView extends ItemView {
  private actualEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: SamayaPlugin) { super(leaf); }
  getViewType() { return FOCUS_VIEW_TYPE; }
  getDisplayText() { return "Focus"; }
  getIcon() { return "timer"; }
  async onOpen() {
    this.render();
    this.registerInterval(window.setInterval(() => this.tick(), 1000));
  }

  private tick() {
    const fm = this.plugin.focus; const f = fm.file; if (!fm.state || !f || !this.actualEl) return;
    const t = readTask(this.app, f);
    const actualMin = t.actual + fm.sessionMs() / 60000;
    this.actualEl.setText(fmtHm(actualMin));
    const over = !!t.estimate && actualMin > t.estimate;
    this.actualEl.toggleClass("is-over", over);
    if (this.barEl) { this.barEl.style.width = `${t.estimate ? Math.min(100, (actualMin / t.estimate) * 100) : 0}%`; this.barEl.toggleClass("is-over", over); }
  }

  render() {
    const c = this.contentEl; c.empty(); c.addClass("samaya-focus");
    const fm = this.plugin.focus; const st = fm.state; const file = fm.file;
    if (!st || !file) { c.createDiv({ cls: "samaya-empty", text: "No task in focus. Right-click a task and choose Start focus." }); this.actualEl = null; return; }
    const t = readTask(this.app, file);
    c.removeClass("is-focus"); c.removeClass("is-break"); c.addClass(st.startedAt ? "is-focus" : "is-break");
    const banner = c.createDiv("samaya-focus-banner");
    banner.createSpan({ cls: "samaya-focus-dot" });
    banner.createSpan({ text: st.startedAt ? "FOCUS MODE" : "BREAK - timer paused" });
    c.createEl("h2", { cls: "samaya-focus-title", text: t.title });
    const tp = ticketPathOf(this.app, t); const tf = tp ? this.app.vault.getAbstractFileByPath(tp) : null;
    if (tf instanceof TFile) { const tk = readTicket(this.app, tf); c.createDiv({ cls: `samaya-chip samaya-chip-ticket is-${tk.source}`, text: `${tk.key} ${tk.summary}` }); }

    const row = c.createDiv("samaya-focus-buttons");
    const btn = (kind: IconKind, label: string, fn: () => Promise<void>, cta = false) => {
      const b = row.createEl("button", { cls: "samaya-focus-btn" + (cta ? " mod-cta" : ""), attr: { "aria-label": label, title: label } });
      drawIcon(b, kind); b.onclick = () => { void fn(); };
    };
    if (st.startedAt) btn("pause", "Pause", () => fm.pause()); else btn("play", "Resume", () => fm.resume(), true);
    btn("check", "Complete and log time", () => fm.stop(true));

    const stats = c.createDiv("samaya-focus-stats");
    const stat = (label: string, value: string) => { const d = stats.createDiv("samaya-focus-stat"); d.createDiv({ cls: "samaya-focus-stat-label", text: label }); return d.createDiv({ cls: "samaya-focus-stat-value", text: value }); };
    stat("Planned", t.estimate ? fmtHm(t.estimate) : "--:--");
    this.actualEl = stat("Actual so far", "");
    const bar = c.createDiv("samaya-focus-bar"); this.barEl = bar.createDiv("samaya-focus-bar-fill");
    this.tick();

    c.createEl("button", { text: "Open note" }).onclick = () => { void this.app.workspace.getLeaf("tab").openFile(file); };

    c.createEl("h4", { text: "Subtasks" });
    void renderSubtasks(this.plugin, c.createDiv("samaya-subs samaya-focus-subs"), file);
  }
}
