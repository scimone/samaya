import { Modal, Notice, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { Dest, Task, allTasks, onDay, sendPiece } from "../model";
import { SplitTo, splitTask } from "./place";
import { addDays, fmtDur, parseYmd, startOfWeek, today } from "../util";

type Choice = { key: string; label: string; sub?: string; icon?: string; split: SplitTo; dest: Dest; said: string };

/**
 * Split a task (drag the cut on the bar, pick where the rest goes), or move one of its parts to another day.
 * `task` is the day's view of the task (a card or a timeline block); `seg` the block of a split day that was used.
 */
export class PartsModal extends Modal {
  private choice: Choice | null = null;
  private first = 0;
  constructor(private plugin: SamayaPlugin, private task: Task, private mode: "split" | "move", private seg: number | null = null) { super(plugin.app); }

  /** The piece in hand: the block that was used, else the longest block of a split day, else the day's only piece. */
  private pieceIndex(): number | null {
    const g = this.task.segments;
    if (g.length < 2) return null;
    if (this.seg !== null && g[this.seg]) return this.seg;
    return g.reduce((best, x, i) => (x.dur > g[best].dur ? i : best), 0);
  }

  onOpen() {
    const s = this.plugin.settings; const t = this.task; const day = t.planned; const k = this.pieceIndex();
    const dur = k !== null ? t.segments[k].dur : t.estimate;
    const step = Math.max(5, s.slotMinutes); const timed = k !== null || !!t.start; const split = this.mode === "split";
    this.modalEl.addClass("samaya-parts-modal");
    this.titleEl.setText(split ? "Split task" : "Move to another day");
    this.contentEl.createDiv({ cls: "samaya-parts-task", text: t.title });

    if (split && dur < step * 2) {
      this.contentEl.createEl("p", { cls: "samaya-parts-note", text: dur ? `${fmtDur(dur)} is too short to split.` : "Give the task an estimate first." });
      this.contentEl.createDiv("samaya-ritual-nav").createEl("button", { text: "Close" }).onclick = () => this.close();
      return;
    }

    // ---- the cut: drag the line on the bar
    let paint = () => { /* set below */ };
    if (split) {
      const lo = step, hi = Math.floor((dur - step) / step) * step;
      this.first = Math.min(hi, Math.max(lo, Math.round(dur / 2 / step) * step));
      const bar = this.contentEl.createDiv({ cls: "samaya-parts-bar", attr: { role: "slider", tabindex: "0", "aria-label": "Length of the first part", "aria-valuemin": String(lo), "aria-valuemax": String(hi) } });
      const a = bar.createDiv("samaya-parts-a"); const b = bar.createDiv("samaya-parts-b");
      paint = () => {
        a.setText(fmtDur(this.first)); b.setText(fmtDur(dur - this.first));
        a.style.flexGrow = String(this.first); b.style.flexGrow = String(dur - this.first); bar.setAttr("aria-valuenow", String(this.first));
      };
      const at = (x: number) => { const r = bar.getBoundingClientRect(); this.first = Math.min(hi, Math.max(lo, Math.round(((x - r.left) / Math.max(1, r.width)) * dur / step) * step)); paint(); };
      bar.addEventListener("pointerdown", e => { bar.setPointerCapture(e.pointerId); at(e.clientX); const mv = (ev: PointerEvent) => at(ev.clientX); bar.addEventListener("pointermove", mv); bar.addEventListener("pointerup", () => bar.removeEventListener("pointermove", mv), { once: true }); });
      bar.addEventListener("keydown", e => { const d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0; if (!d) return; e.preventDefault(); this.first = Math.min(hi, Math.max(lo, this.first + d)); paint(); });
      this.contentEl.createDiv({ cls: "samaya-parts-hint", text: "Drag the line to set where to cut" });
    }

    // ---- where does the rest (or the part) go
    this.contentEl.createDiv({ cls: "samaya-parts-h", text: split ? "The rest goes…" : "Move to…" });
    const wrap = this.contentEl.createDiv("samaya-parts-choices");
    const chips = new Map<string, HTMLElement>();
    const add = (row: HTMLElement, c: Choice) => {
      const el = row.createEl("button", { cls: "samaya-parts-chip", attr: { type: "button", "aria-pressed": "false" } });
      if (c.icon) setIcon(el.createSpan({ cls: "samaya-parts-chip-icon" }), c.icon);
      el.createSpan({ cls: "samaya-parts-chip-label", text: c.label });
      if (c.sub) el.createSpan({ cls: "samaya-parts-chip-sub", text: c.sub });
      el.onclick = () => pick(c); chips.set(c.key, el); return c;
    };
    const pick = (c: Choice) => { this.choice = c; chips.forEach((el, key) => { const on = key === c.key; el.toggleClass("is-active", on); el.setAttr("aria-pressed", String(on)); }); };
    const all = allTasks(this.app, s);
    const load = (d: string) => onDay(all, d).reduce((a, x) => a + (x.estimate || s.defaultEstimate), 0);
    const dayChip = (row: HTMLElement, d: string) => add(row, { key: d, label: parseYmd(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }), sub: load(d) ? fmtDur(load(d)) : "free", split: { kind: "day", date: d }, dest: { day: d }, said: parseYmd(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }) });

    let firstChoice: Choice | null = null;
    if (split && timed) firstChoice = add(wrap.createDiv("samaya-parts-row"), { key: "same", label: "Right after", sub: "same day", icon: "arrow-down-to-line", split: { kind: "same" }, dest: { day }, said: "right after" });
    // the days of the week of the piece (from today on), and the next week when this one has run out
    const lastDow = Math.max(5, Math.min(7, s.workDays)); const wk0 = startOfWeek(day < today() ? today() : day);
    const week = (wk: string) => Array.from({ length: lastDow }, (_, i) => addDays(wk, i)).filter(d => d >= today() && d !== day);
    let days = week(wk0); const days2 = days.length < 2 ? week(addDays(wk0, 7)) : [];
    for (const list of [days, days2]) if (list.length) { const row = wrap.createDiv("samaya-parts-row"); list.forEach(d => { const c = dayChip(row, d); firstChoice ??= c; }); }
    const other = wrap.createDiv("samaya-parts-row");
    const wkLabel = wk0 === startOfWeek(today()) ? "This week" : `Week of ${parseYmd(wk0).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
    add(other, { key: "week", label: wkLabel, sub: "no day yet", split: { kind: "week", week: wk0 }, dest: { week: wk0 }, said: "this week's list" });
    add(other, { key: "next", label: "Backlog", sub: "next week", split: { kind: "backlog", horizon: "week" }, dest: { backlog: "week" }, said: "next week's backlog" });
    add(other, { key: "someday", label: "Backlog", sub: "someday", split: { kind: "backlog", horizon: "someday" }, dest: { backlog: "someday" }, said: "the backlog" });

    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    nav.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = () => { void this.run(day, k); };
    nav.createEl("button", { text: split ? "Split" : "Move", cls: "mod-cta" }).onclick = ok;
    pick(firstChoice ?? { key: "week", label: "", split: { kind: "week", week: wk0 }, dest: { week: wk0 }, said: "this week's list" });
    paint();
    this.scope.register([], "Enter", () => { ok(); return false; });
  }

  private async run(day: string, k: number | null) {
    const c = this.choice; if (!c) return;
    this.close();
    const t = this.task;
    if (this.mode === "split") {
      if (await splitTask(this.plugin, t.file, day, k, this.first, c.split)) new Notice(`Split “${t.title}”: ${fmtDur(this.first)} stays, the rest goes to ${c.said}.`);
    } else {
      await sendPiece(this.app, this.plugin.settings, t.file, { day, seg: k }, c.dest);
      new Notice(`Moved to ${c.said}.`);
    }
  }
}
