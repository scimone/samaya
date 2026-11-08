import { FuzzySuggestModal, Modal, Notice } from "obsidian";
import type SamayaPlugin from "./main";
import { Project, allProjects } from "./projects";
import { Task, Ticket, allTasks, allTickets, patchTask, setDone, sortTasks } from "./model";
import { journalWants, taskLines, toJournalTasks, writeSection } from "./journal";
import { addDays, fmtDur, startOfWeek, today } from "./util";

export class TextPromptModal extends Modal {
  constructor(private plugin: SamayaPlugin, private label: string, private onSubmit: (v: string) => void, private initial = "") { super(plugin.app); }
  onOpen() {
    this.contentEl.createEl("p", { text: this.label });
    const inp = this.contentEl.createEl("input", { type: "text" }); inp.style.width = "100%"; inp.value = this.initial; inp.focus();
    const go = () => { const v = inp.value.trim(); this.close(); if (v) this.onSubmit(v); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    this.contentEl.createDiv({ cls: "samaya-ritual-nav" }).createEl("button", { text: "OK", cls: "mod-cta" }).onclick = go;
  }
}

/** "X does not exist yet - create it?" */
export class ConfirmCreateModal extends Modal {
  constructor(plugin: SamayaPlugin, private path: string, private onCreate: () => void, private extra = "") { super(plugin.app); }
  onOpen() {
    this.titleEl.setText("Note does not exist yet");
    this.contentEl.createEl("p", { text: "This note has not been created yet:" });
    this.contentEl.createEl("code", { text: this.path });
    if (this.extra) this.contentEl.createEl("p", { text: this.extra });
    this.contentEl.createEl("p", { text: "Do you want to create it?" });
    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    nav.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = nav.createEl("button", { text: "Create", cls: "mod-cta" });
    ok.onclick = () => { this.close(); this.onCreate(); };
    ok.focus();
  }
}

export class TicketSuggestModal extends FuzzySuggestModal<Ticket | null> {
  constructor(private plugin: SamayaPlugin, private choose: (t: Ticket | null) => void) {
    super(plugin.app); this.setPlaceholder("Assign to ticket…");
  }
  getItems() { return allTickets(this.app, this.plugin.settings).filter(t => t.state !== "closed"); }
  getItemText(t: Ticket | null) { return t ? `${t.key}  ${t.summary}` : "(no ticket)"; }
  onChooseItem(t: Ticket | null) { this.choose(t); }
}

export class ProjectSuggestModal extends FuzzySuggestModal<Project> {
  constructor(private plugin: SamayaPlugin, private choose: (p: Project) => void) { super(plugin.app); this.setPlaceholder("Assign to project…"); }
  getItems() { return allProjects(this.app, this.plugin.settings).filter(p => !p.done); }
  getItemText(p: Project) { return p.name; }
  onChooseItem(p: Project) { this.choose(p); }
}

abstract class Stepper extends Modal {
  protected step = 0;
  constructor(protected plugin: SamayaPlugin) { super(plugin.app); }
  protected abstract titles(): string[];
  protected abstract body(el: HTMLElement): void;
  protected abstract finish(): Promise<void>;
  onOpen() { this.modalEl.addClass("samaya-ritual"); this.render(); }
  protected render() {
    const c = this.contentEl; c.empty();
    const t = this.titles();
    const bar = c.createDiv("samaya-steps");
    t.forEach((x, i) => bar.createSpan({ cls: "samaya-step" + (i === this.step ? " is-active" : i < this.step ? " is-done" : ""), text: `${i + 1}. ${x}` }));
    c.createEl("h2", { text: t[this.step] });
    this.body(c.createDiv("samaya-ritual-body"));
    const nav = c.createDiv("samaya-ritual-nav");
    if (this.step > 0) nav.createEl("button", { text: "Back" }).onclick = () => { this.step--; this.render(); };
    const last = this.step === t.length - 1;
    nav.createEl("button", { text: last ? "Finish" : "Next", cls: "mod-cta" }).onclick = async () => {
      if (last) { await this.finish(); this.close(); } else { this.step++; this.render(); }
    };
  }
  protected actionRow(parent: HTMLElement, t: Task, actions: Array<[string, () => Promise<void>]>) {
    const row = parent.createDiv("samaya-ritual-row");
    row.createSpan({ cls: "samaya-ritual-title", text: t.title });
    if (t.estimate) row.createSpan({ cls: "samaya-chip", text: fmtDur(t.estimate) });
    const b = row.createDiv("samaya-ritual-actions");
    actions.forEach(([label, fn]) => { b.createEl("button", { text: label }).onclick = async () => { await fn(); await new Promise(r => setTimeout(r, 250)); this.render(); }; });
  }
}

export class ShutdownModal extends Stepper {
  protected titles() { return ["Review", "Move unfinished", "Plan tomorrow"]; }
  protected body(el: HTMLElement) {
    const tasks = allTasks(this.app, this.plugin.settings); const td = today(); const tm = addDays(td, 1);
    const day = tasks.filter(t => t.planned === td);
    if (this.step === 0) {
      const done = day.filter(t => t.status === "done");
      const planned = day.reduce((a, t) => a + t.estimate, 0), actual = day.reduce((a, t) => a + t.actual, 0);
      el.createDiv({ cls: "samaya-total", text: `${done.length}/${day.length} tasks done · planned ${fmtDur(planned)} · tracked ${fmtDur(actual)}` });
      sortTasks(day).forEach(t => {
        const row = el.createDiv("samaya-ritual-row" + (t.status === "done" ? " is-done" : ""));
        row.createSpan({ cls: "samaya-ritual-title", text: (t.status === "done" ? "✓ " : "○ ") + t.title });
        row.createSpan({ cls: "samaya-chip", text: `${fmtDur(t.actual)} / ${fmtDur(t.estimate)}` });
      });
    } else if (this.step === 1) {
      const left = sortTasks(day.filter(t => t.status !== "done"));
      if (!left.length) el.createDiv({ cls: "samaya-empty", text: "Everything is done." });
      left.forEach(t => this.actionRow(el, t, [
        ["Tomorrow", () => patchTask(this.app, t.file, { planned: tm, start: null })],
        ["Backlog", () => patchTask(this.app, t.file, { planned: null, start: null })],
        ["Done", () => setDone(this.app, t, true)],
      ]));
    } else {
      const pick = (t: Task) => (): Promise<void> => patchTask(this.app, t.file, { planned: tm, week: null, estimate: t.estimate || this.plugin.settings.defaultEstimate });
      const wk = startOfWeek(td);
      const planned = sortTasks(tasks.filter(t => t.planned === tm));
      el.createEl("h4", { text: `Planned for tomorrow (${planned.length})` });
      planned.forEach(t => this.actionRow(el, t, [["Remove", () => patchTask(this.app, t.file, { planned: null, start: null })]]));
      const cand = sortTasks(tasks.filter(t => !t.planned && t.status !== "done")).sort((a, b) => Number(b.week === wk) - Number(a.week === wk));
      el.createEl("h4", { text: "Add from this week / backlog" });
      if (!cand.length) el.createDiv({ cls: "samaya-empty", text: "Nothing in the backlog." });
      cand.forEach(t => this.actionRow(el, t, [["Tomorrow", pick(t)]]));
    }
  }
  protected async finish() {
    const s = this.plugin.settings; const td = today(); const tm = addDays(td, 1);
    const all = allTasks(this.app, s);
    const finished = sortTasks(all.filter(t => t.status === "done" && t.planned === td));
    const tomorrow = sortTasks(all.filter(t => t.planned === tm && t.status !== "done"));
    if (journalWants(s, "journalFinished")) await writeSection(this.app, s, td, "Finished today", taskLines(await toJournalTasks(this.app, finished, true)));
    if (journalWants(s, "journalTomorrow")) await writeSection(this.app, s, td, "Planned for tomorrow", taskLines(await toJournalTasks(this.app, tomorrow)));
    await this.plugin.workday.endDay();
    new Notice(`Shutdown complete${s.journalOn ? " - saved to your journal" : ""}. See you tomorrow.`);
  }
}
