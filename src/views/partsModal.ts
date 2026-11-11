import { Modal, Notice, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { Dest, Task, allTasks, onDay, sendPiece } from "../model";
import { SplitTo, splitTask } from "./place";
import { addDays, fmtDur, minToHm, parseYmd, startOfWeek, today } from "../util";

type Choice = { key: string; label: string; sub?: string; icon?: string; split: SplitTo; dest: Dest };

/**
 * Split a task by hand, or move one of its parts: how long the first part is, and where the rest goes (right after on the same day,
 * another day, this week's list or the backlog). `task` is the day's view of the task (a card or a timeline block); `seg` the piece of a split day.
 */
export class PartsModal extends Modal {
  private choice: Choice | null = null;
  private first = 0;
  constructor(private plugin: SamayaPlugin, private task: Task, private mode: "split" | "move", private seg: number | null = null) { super(plugin.app); }

  /** The piece in hand: a block of a split day, the longest block when a card of a split day is used, or the day's only piece. */
  private pieceIndex(): number | null {
    const g = this.task.segments;
    if (g.length < 2) return null;
    if (this.seg !== null && g[this.seg]) return this.seg;
    return g.reduce((best, x, i) => (x.dur > g[best].dur ? i : best), 0);
  }

  onOpen() {
    const s = this.plugin.settings; const t = this.task; const day = t.planned; const k = this.pieceIndex();
    const dur = k !== null ? t.segments[k].dur : t.estimate;
    const step = Math.max(5, s.slotMinutes); const timed = k !== null || !!t.start;
    const split = this.mode === "split";
    this.modalEl.addClass("samaya-parts-modal");
    this.titleEl.setText(split ? "Split task" : "Move to another day");
    this.contentEl.createDiv({ cls: "samaya-parts-task", text: t.title });

    if (split && dur < step * 2) {
      this.contentEl.createEl("p", { cls: "samaya-parts-note", text: `This piece is only ${fmtDur(dur)} long: it cannot be split into parts of at least ${fmtDur(step)}. Give the task a longer estimate first.` });
      this.contentEl.createDiv("samaya-ritual-nav").createEl("button", { text: "Close" }).onclick = () => this.close();
      return;
    }

    // ---- how long is the first part
    let paint = () => { /* set below */ };
    if (split) {
      const lo = step, hi = Math.floor((dur - step) / step) * step;
      this.first = Math.min(hi, Math.max(lo, Math.round(dur / 2 / step) * step));
      const box = this.contentEl.createDiv("samaya-parts-split");
      const bar = box.createDiv("samaya-parts-bar"); const a = bar.createDiv("samaya-parts-a"); const b = bar.createDiv("samaya-parts-b");
      const lab = box.createDiv("samaya-parts-labels"); const la = lab.createSpan(); const lb = lab.createSpan();
      const range = box.createEl("input", { type: "range", cls: "samaya-parts-range", attr: { min: String(lo), max: String(hi), step: String(step), "aria-label": "Length of the first part" } });
      range.value = String(this.first);
      const nudge = box.createDiv("samaya-parts-nudge");
      for (const [txt, d] of [["−", -step], ["+", step]] as const) {
        const btn = nudge.createEl("button", { cls: "samaya-mini", text: `${txt} ${fmtDur(step)}`, attr: { type: "button" } });
        btn.onclick = () => { range.value = String(Math.min(hi, Math.max(lo, Number(range.value) + d))); range.dispatchEvent(new Event("input")); };
      }
      paint = () => {
        this.first = Number(range.value); const left = dur - this.first;
        a.style.flexGrow = String(this.first); b.style.flexGrow = String(left);
        la.setText(`First part  ${fmtDur(this.first)}${timed && t.start ? `  ·  stays at ${minToHm(k !== null ? t.segments[k].s : parseHm(t.start))}` : ""}`);
        lb.setText(`Rest  ${fmtDur(left)}`);
      };
      range.addEventListener("input", paint);
    } else {
      this.contentEl.createDiv({ cls: "samaya-parts-note", text: `${fmtDur(dur)} will move${k !== null ? " (this part)" : ""}. It lands in the day's list without a time.` });
    }

    // ---- where does it go
    this.contentEl.createDiv({ cls: "samaya-parts-h", text: split ? "Where does the rest go?" : "Move to" });
    const wrap = this.contentEl.createDiv("samaya-parts-choices");
    const choices: Choice[] = [];
    const chips = new Map<string, HTMLElement>();
    const add = (row: HTMLElement, c: Choice) => {
      choices.push(c);
      const el = row.createEl("button", { cls: "samaya-parts-chip", attr: { type: "button", "aria-pressed": "false" } });
      if (c.icon) setIcon(el.createSpan({ cls: "samaya-parts-chip-icon" }), c.icon);
      el.createSpan({ cls: "samaya-parts-chip-label", text: c.label });
      if (c.sub) el.createSpan({ cls: "samaya-parts-chip-sub", text: c.sub });
      el.onclick = () => pick(c); chips.set(c.key, el);
    };
    const pick = (c: Choice) => { this.choice = c; chips.forEach((el, key) => { const on = key === c.key; el.toggleClass("is-active", on); el.setAttr("aria-pressed", String(on)); }); okBtn.disabled = false; };

    if (split && timed) add(wrap.createDiv("samaya-parts-row"), { key: "same", label: "Right after", sub: "same day", icon: "arrow-down-to-line", split: { kind: "same" }, dest: { day } });

    // days: the working days of this and the next week, from today on
    const all = allTasks(this.app, s); const lastDow = Math.max(5, Math.min(7, s.workDays));
    const load = (d: string) => onDay(all, d).reduce((a, x) => a + (x.estimate || s.defaultEstimate), 0);
    const base = startOfWeek(today());
    for (const wk of [base, addDays(base, 7)]) {
      const row = wrap.createDiv("samaya-parts-row"); row.createSpan({ cls: "samaya-parts-rowlabel", text: wk === base ? "This week" : "Next week" });
      let n = 0;
      for (let i = 0; i < lastDow; i++) {
        const d = addDays(wk, i); if (d < today() || d === day) continue;
        const min = load(d);
        add(row, { key: d, label: parseYmd(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }), sub: min ? fmtDur(min) : "free", split: { kind: "day", date: d }, dest: { day: d } });
        n++;
      }
      if (!n) row.remove();
    }
    const other = wrap.createDiv("samaya-parts-row"); other.createSpan({ cls: "samaya-parts-rowlabel", text: "Other" });
    const wkThis = startOfWeek(day < today() ? today() : day);
    add(other, { key: "week", label: wkThis === base ? "This week" : `Week of ${parseYmd(wkThis).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`, sub: "no day yet", icon: "calendar-range", split: { kind: "week", week: wkThis }, dest: { week: wkThis } });
    add(other, { key: "backlog", label: "Backlog", sub: "someday", icon: "inbox", split: { kind: "backlog", horizon: "someday" }, dest: { backlog: "someday" } });
    const dateBox = other.createEl("label", { cls: "samaya-parts-date", text: "Date " });
    const dateIn = dateBox.createEl("input", { type: "date", attr: { min: today() } });
    dateIn.onchange = () => {
      if (!dateIn.value) return; const d = dateIn.value; chips.delete("date");
      const c: Choice = { key: "date", label: d, split: { kind: "day", date: d }, dest: { day: d } }; choices.push(c); this.choice = c;
      chips.forEach(el => { el.removeClass("is-active"); el.setAttr("aria-pressed", "false"); }); okBtn.disabled = false;
    };

    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    nav.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const okBtn = nav.createEl("button", { text: split ? "Split" : "Move", cls: "mod-cta" }); okBtn.disabled = true;
    okBtn.onclick = () => { void this.run(day, k); };
    const first = choices.find(c => c.key === "same") ?? choices.find(c => c.key !== "week" && c.key !== "backlog") ?? choices[0];
    if (first) pick(first);
    paint();
    this.scope.register([], "Enter", () => { if (!okBtn.disabled) { void this.run(day, k); return false; } });
  }

  private async run(day: string, k: number | null) {
    const c = this.choice; if (!c) return;
    this.close();
    const t = this.task; const file = t.file;
    if (this.mode === "split") {
      const ok = await splitTask(this.plugin, file, day, k, this.first, c.split);
      if (ok) new Notice(`Split “${t.title}”: ${fmtDur(this.first)} stays, ${where(c)} gets the rest.`);
    } else {
      await sendPiece(this.app, this.plugin.settings, file, { day, seg: k }, c.dest);
      new Notice(`Moved to ${where(c)}.`);
    }
  }
}

const parseHm = (hm: string): number => { const [h, m] = hm.split(":").map(Number); return h * 60 + (m || 0); };
function where(c: Choice): string {
  if (c.key === "same") return "the same day";
  if (c.key === "week") return "this week's list";
  if (c.key === "backlog") return "the backlog";
  return parseYmd(c.key === "date" ? c.label : c.key).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}
