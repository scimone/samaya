import { Notice, TFile, setIcon } from "obsidian";
import { bannerSlots } from "./bars";
import type SamayaPlugin from "./main";
import { openFileSmart, openFull } from "./openfile";
import { dayTask, patchTask, readTask } from "./model";
import { roundCheck, trackedBefore } from "./views/place";
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
  /** Minutes of the running session of `path` that are not in the task's duration_actual yet (0 for any other task, and while paused). */
  liveMin(path: string): number { const st = this.state; return st && st.path === path ? Math.max(0, this.sessionMs() / 60000 - (st.loggedMin ?? 0)) : 0; }
  get file(): TFile | null { const f = this.state && this.plugin.app.vault.getAbstractFileByPath(this.state.path); return f instanceof TFile ? f : null; }

  private async persist() { this.plugin.data.focus = this.state; await this.plugin.saveData(this.plugin.data); }
  private refreshViews() {
    document.body.toggleClass("samaya-focusing", !!this.state?.startedAt); // while a focus runs (not paused): dims the rest of the day and hides the planning buttons
    document.querySelectorAll(".samaya-focus-bar").forEach(el => el.remove());
    this.ensureBanners();
    void this.plugin.markJournalNotes(); // the task note's card follows the focus
    this.plugin.refreshPlanner(); // cards and timeline blocks follow the focus
  }

  /** The banner under the header of the pane that is showing (across all panes when the editor is split, see bars.ts), while a focus runs (or is paused). Two looks: the minimal one (label and progress line) on the focused task's own note, a slim reminder on every other page. */
  private ensureBanners() {
    if (!this.state) { document.querySelectorAll(".samaya-focus-bar").forEach(el => el.remove()); return; }
    let added = false;
    for (const { host, leaf, span } of bannerSlots(this.plugin.app)) {
      const here = (leaf?.view as { file?: TFile } | undefined)?.file?.path === this.state.path;
      const variant = here ? "current" : "elsewhere";
      const have = host.querySelector<HTMLElement>(":scope > .samaya-focus-bar");
      if (have && have.dataset.variant === variant) return;
      have?.remove();
      const bar = createDiv("samaya-focus-bar"); bar.dataset.variant = variant; bar.toggleClass("is-current", here);
      if (!here) bar.addEventListener("click", e => { if (!(e.target as HTMLElement).closest("button, a, .samaya-rcheck")) this.openNote(); }); // the bar itself: back to the task in a full page
      const header = host.querySelector(":scope > .view-header");
      const meet = host.querySelector(":scope > .samaya-meet-bar"); // a meeting banner stays on top
      if (meet) meet.after(bar); else if (header && !span) header.after(bar); else host.prepend(bar);
      this.buildBanner(bar, here); added = true;
    }
    if (added) this.tickBanners();
  }
  private buildBanner(bar: HTMLElement, here: boolean) {
    const st = this.state; const file = this.file; if (!st) return;
    bar.toggleClass("is-focus", !!st.startedAt); bar.toggleClass("is-break", !st.startedAt);
    const btn = (parent: HTMLElement, icon: string, label: string, fn: () => Promise<void>, cls = "") => {
      const b = parent.createEl("button", { cls: `samaya-focus-bbtn ${cls}`.trim(), attr: { "aria-label": label } });
      setIcon(b.createSpan({ cls: "samaya-focus-bicon" }), icon); if (here) b.createSpan({ text: label.split(" ")[0] });
      b.addEventListener("click", () => { void fn(); });
    };
    const status = bar.createDiv("samaya-focus-status");
    status.createSpan({ cls: "samaya-focus-dot" });
    status.createSpan({ cls: "samaya-focus-state", text: st.startedAt ? (here ? "In focus" : "Focusing") : "Paused" });
    if (!here) {
      // somewhere else: say what is running, and a way back
      roundCheck(bar, false, "Complete the task and log the time", () => { void this.stop(true); }); // replaces a Done button
      const link = bar.createEl("a", { cls: "samaya-focus-link", text: file?.basename ?? "", attr: { title: "Back to the task" } });
      link.addEventListener("click", e => { e.preventDefault(); this.openNote(); });
      bar.createSpan({ cls: "samaya-focus-prog" });
    }
    if (here) { bar.createDiv("samaya-focus-meter"); return; } // the task's own note: just the label and the progress line (clock, Pause and the checkbox are on the title line)
    const ctl = bar.createDiv("samaya-focus-ctl");
    if (st.startedAt) btn(ctl, "pause", "Pause", () => this.pause(), "mod-cta");
    else { btn(ctl, "play", "Resume", () => this.resume(), "mod-cta"); btn(ctl, "square", "Stop (log the time, task stays open)", () => this.stop(false)); }
    bar.createDiv("samaya-focus-meter");
  }
  private tickBanners() {
    const st = this.state; const f = this.file; if (!st) return;
    const t = f ? readTask(this.plugin.app, f) : null;
    // a task spread over several days: today's piece is the plan, and what was tracked on earlier days does not count
    const day = t ? dayTask(t, today()) : null;
    const before = t ? trackedBefore(this.plugin, t, today()) : 0;
    const actual = t ? Math.max(0, t.actual - before + this.sessionMs() / 60000 - (st.loggedMin ?? 0)) : 0; // the logged part is already in t.actual
    const planned = day ? day.estimate : 0;
    document.querySelectorAll<HTMLElement>(".samaya-est[data-focus-base]").forEach(el => { // the focused task's cards count along with the banner
      const now = +el.dataset.focusBase! + this.liveMin(st.path); const est = +(el.dataset.focusMin ?? 0);
      el.setText(`${fmtHm(now)}/${el.dataset.focusEst}`); el.style.setProperty("--p", `${est ? Math.min(100, (now / est) * 100) : 0}%`); el.toggleClass("is-over", !!est && now > est);
    });
    document.querySelectorAll<HTMLElement>(".samaya-tc-act[data-tc-base]").forEach(el => el.setText(fmtHm(+el.dataset.tcBase! + this.liveMin(st.path))));
    document.querySelectorAll<HTMLElement>(".samaya-focus-bar").forEach(bar => {
      const prog = bar.querySelector<HTMLElement>(".samaya-focus-prog");
      if (prog && t) { prog.setText(`${fmtHm(actual)} / ${planned ? fmtHm(planned) : "--:--"}`); prog.toggleClass("is-over", !!planned && actual > planned); }
      bar.style.setProperty("--p", planned ? `${Math.min(100, (actual / planned) * 100)}%` : "0%");
    });
  }
  openNote() { const f = this.file; if (f) void openFull(this.plugin.app, f); } // the focused task: a full page

  async start(file: TFile) {
    if (!this.plugin.workday.started) { new Notice("Samaya: start your day before starting a focus."); return; }
    if (this.state && this.state.path !== file.path) await this.stop(false);
    if (!this.state) this.state = { path: file.path, accumulatedMs: 0, startedAt: Date.now() };
    else if (!this.state.startedAt) this.state.startedAt = Date.now();
    await this.persist();
    // the task note in a full page (the one exception to the side pane), so you can write notes while working
    await openFull(this.plugin.app, file);
    this.refreshViews();
  }
  /** Pause (a pause): write the time worked so far to the task, so duration_actual is up to date during the pause. */
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
  /** Stop (the last run is logged like a pause), optionally complete the task. */
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

