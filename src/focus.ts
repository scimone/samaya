import { Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type SamayaPlugin from "./main";
import { dayTask, patchTask, readTask } from "./model";
import { trackedBefore } from "./views/place";
import { today } from "./util";
import { fmtDur, fmtHm } from "./util";

/** the retired focus sidebar: leftovers of it in a saved layout are closed */
export const FOCUS_VIEW_TYPE = "samaya-focus";

export interface FocusState { path: string; accumulatedMs: number; startedAt: number | null; /** finished runs (start, end in epoch ms): the time frames actually worked */ runs?: Array<[number, number]>; /** whole minutes of this session already added to the task's duration_actual */ loggedMin?: number; }

const asList = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
/** One focus run as "2026-11-11 09:05–09:40" (the end carries its date when the run crosses midnight). */
const fmtRun = ([a, b]: [number, number]): string => {
  const d = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const hm = (x: Date) => `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
  const A = new Date(a), B = new Date(b); return `${d(A)} ${hm(A)}–${d(A) === d(B) ? "" : d(B) + " "}${hm(B)}`;
};
export class FocusManager {
  state: FocusState | null = null;
  private stopping = false;
  constructor(private plugin: SamayaPlugin) {}

  init(saved: FocusState | null) {
    this.state = saved;
    const app = this.plugin.app;
    this.plugin.registerInterval(window.setInterval(() => this.tickBanners(), 1000));
    const ensure = () => this.ensureBanners();
    this.plugin.registerEvent(app.workspace.on("layout-change", ensure));
    this.plugin.registerEvent(app.workspace.on("active-leaf-change", ensure));
    this.plugin.registerEvent(app.workspace.on("file-open", ensure));
    // checking the focused task off ends the focus and logs the time
    this.plugin.registerEvent(app.metadataCache.on("changed", f => {
      if (this.state && !this.stopping && f.path === this.state.path && app.metadataCache.getFileCache(f)?.frontmatter?.status === "done") void this.stop(false);
    }));
    app.workspace.onLayoutReady(() => { app.workspace.detachLeavesOfType(FOCUS_VIEW_TYPE); this.refreshViews(); });
  }
  /** Session time of the running / paused focus. */
  sessionMs(): number { const s = this.state; return s ? s.accumulatedMs + (s.startedAt ? Date.now() - s.startedAt : 0) : 0; }
  get file(): TFile | null { const f = this.state && this.plugin.app.vault.getAbstractFileByPath(this.state.path); return f instanceof TFile ? f : null; }

  private async persist() { this.plugin.data.focus = this.state; await this.plugin.saveData(this.plugin.data); }
  private refreshViews() {
    document.body.toggleClass("samaya-focusing", !!this.state); // dims the rest of the day while a focus runs
    document.querySelectorAll(".samaya-focus-bar").forEach(el => el.remove());
    this.ensureBanners();
    this.plugin.refreshPlanner(); // cards and timeline blocks follow the focus
  }

  /** The banner on top of every page in the main area while a focus runs (or is on a break). */
  private ensureBanners() {
    const ws = this.plugin.app.workspace;
    if (!this.state) { document.querySelectorAll(".samaya-focus-bar").forEach(el => el.remove()); return; }
    // one banner, in the pane in front (it moves along when another pane is picked)
    const leaf = ws.getMostRecentLeaf(ws.rootSplit); const host = leaf?.view?.containerEl;
    if (!host) return;
    if (host.querySelector(":scope > .samaya-focus-bar")) return;
    document.querySelectorAll(".samaya-focus-bar").forEach(el => el.remove());
    const bar = createDiv("samaya-focus-bar");
    const header = host.querySelector(":scope > .view-header");
    if (header) header.after(bar); else host.prepend(bar);
    this.buildBanner(bar);
    this.tickBanners();
  }
  private buildBanner(bar: HTMLElement) {
    const st = this.state; const file = this.file; if (!st) return;
    bar.toggleClass("is-focus", !!st.startedAt); bar.toggleClass("is-break", !st.startedAt);
    bar.createSpan({ cls: "samaya-focus-dot" });
    bar.createSpan({ cls: "samaya-focus-state", text: st.startedAt ? "FOCUS" : "BREAK" });
    const link = bar.createEl("a", { cls: "samaya-focus-link", text: file?.basename ?? "", attr: { title: "Open task note" } });
    link.addEventListener("click", e => { e.preventDefault(); this.openNote(); });
    bar.createSpan({ cls: "samaya-focus-prog" });
    const btn = (icon: string, label: string, fn: () => Promise<void>) => {
      const b = bar.createEl("button", { cls: "samaya-focus-bbtn", attr: { "aria-label": label, title: label } });
      setIcon(b, icon); b.addEventListener("click", () => { void fn(); });
    };
    if (st.startedAt) btn("pause", "Take a break", () => this.pause()); else btn("play", "Resume", () => this.resume());
    btn("square-check", "Complete and log time", () => this.stop(true));
  }
  private tickBanners() {
    const st = this.state; const f = this.file; if (!st) return;
    const t = f ? readTask(this.plugin.app, f) : null;
    // a task spread over several days: today's piece is the plan, and what was tracked on earlier days does not count
    const day = t ? dayTask(t, today()) : null;
    const before = t ? trackedBefore(this.plugin, t, today()) : 0;
    const actual = t ? Math.max(0, t.actual - before + this.sessionMs() / 60000 - (st.loggedMin ?? 0)) : 0; // the logged part is already in t.actual
    const planned = day ? day.estimate : 0;
    document.querySelectorAll<HTMLElement>(".samaya-focus-bar").forEach(bar => {
      const prog = bar.querySelector<HTMLElement>(".samaya-focus-prog");
      if (prog && t) { prog.setText(`${fmtHm(actual)} / ${planned ? fmtHm(planned) : "--:--"}`); prog.toggleClass("is-over", !!planned && actual > planned); }
    });
  }
  openNote() { const f = this.file; if (f) void this.plugin.app.workspace.getLeaf("tab").openFile(f); }

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
    this.refreshViews();
  }
  /** Pause (a break): write the time worked so far to the task, so duration_actual is up to date during the break. */
  async pause() {
    const s = this.state; if (!s || !s.startedAt) return;
    const now = Date.now(); s.accumulatedMs += now - s.startedAt; (s.runs ??= []).push([s.startedAt, now]); s.startedAt = null;
    await this.logProgress(); await this.persist(); this.refreshViews();
  }
  /** Add the minutes worked since the last log to `duration_actual` and the finished runs to `focus_sessions`. */
  private async logProgress() {
    const s = this.state; const file = this.file; if (!s || !file) return;
    const total = Math.round(s.accumulatedMs / 60000); const delta = total - (s.loggedMin ?? 0);
    const runs = (s.runs ?? []).filter(r => r[1] - r[0] >= 60000).map(fmtRun);
    if (delta <= 0 && !runs.length) return;
    const app = this.plugin.app; const t = readTask(app, file);
    await patchTask(app, file, {
      ...(delta > 0 ? { actual: t.actual + delta } : {}),
      ...(runs.length ? { focus_sessions: [...asList(app.metadataCache.getFileCache(file)?.frontmatter?.focus_sessions), ...runs] } : {}),
    });
    s.loggedMin = total; s.runs = [];
  }
  async resume() { const s = this.state; if (!s || s.startedAt) return; s.startedAt = Date.now(); await this.persist(); this.refreshViews(); }
  /** Stop (the last run is logged like a break), optionally complete the task. */
  async stop(markDone: boolean) {
    const s = this.state; if (!s || this.stopping) return;
    this.stopping = true;
    try { await this.stopRun(s, markDone); } finally { this.stopping = false; }
  }
  private async stopRun(s: FocusState, markDone: boolean) {
    await this.pause();
    const minutes = s.loggedMin ?? 0; const file = this.file;
    this.state = null; await this.persist();
    this.refreshViews();
    if (file) {
      if (markDone) await patchTask(this.plugin.app, file, { status: "done", completed: new Date().toISOString().slice(0, 10) });
      new Notice(`Logged ${fmtDur(minutes)} on "${file.basename}"${markDone || readTask(this.plugin.app, file).status === "done" ? " - done" : ""}`);
    }
  }
}

