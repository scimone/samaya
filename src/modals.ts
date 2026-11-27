import { isDoneState } from "./kanban";
import { FuzzySuggestModal, Modal, SuggestModal, prepareFuzzySearch } from "obsidian";
import type SamayaPlugin from "./main";
import type { TFile } from "obsidian";
import { allMeetings, meetingLabel } from "./links";
import { Project, allProjects, createProject, projectLabel, projectPathOf, readProject } from "./projects";
import { SOURCE_NAMES, Task, Ticket, allTasks, allTickets } from "./model";
import { Break, BreakKind, Extra } from "./worktime";
import { Notice } from "obsidian";
import { HORIZONS, Horizon, fmtDur, hmToMin, parseDuration } from "./util";

export class TextPromptModal extends Modal {
  constructor(plugin: SamayaPlugin, private label: string, private onSubmit: (v: string) => void, private initial = "", private allowEmpty = false) { super(plugin.app); }
  onOpen() {
    this.contentEl.createEl("p", { text: this.label });
    const inp = this.contentEl.createEl("input", { type: "text" }); inp.style.width = "100%"; inp.value = this.initial; inp.focus();
    const go = () => { const v = inp.value.trim(); this.close(); if (v || this.allowEmpty) this.onSubmit(v); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) go(); });
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

/** "A plan is already saved in this note - overwrite it?" Closing the dialog keeps the saved plan. */
export class ConfirmOverwriteModal extends Modal {
  private answered = false;
  constructor(plugin: SamayaPlugin, private noteLabel: string, private answer: (overwrite: boolean) => void) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText(`Update your ${this.noteLabel}?`);
    this.contentEl.createEl("p", { text: `Your plan in Samaya is saved either way. Your ${this.noteLabel} already has a plan from an earlier planning. Replace the plan written in the note with the one you just made?` });
    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    const done = (v: boolean) => { this.answered = true; this.close(); this.answer(v); };
    const keep = nav.createEl("button", { text: "Keep note as it is" }); keep.onclick = () => done(false);
    nav.createEl("button", { text: "Update note", cls: "mod-cta" }).onclick = () => done(true);
    keep.focus();
  }
  onClose() { if (!this.answered) { this.answered = true; this.answer(false); } }
}

/** "Delete this task?" - the delete button is the warning one; Cancel has the focus. */
export class ConfirmDeleteModal extends Modal {
  constructor(plugin: SamayaPlugin, private title: string, private onDelete: () => void, private noun = "task", private extra = "") { super(plugin.app); }
  onOpen() {
    this.titleEl.setText(`Delete ${this.noun}?`);
    this.contentEl.createEl("p", { text: `“${this.title}” will be deleted (it goes where your vault's “Deleted files” setting sends it).` });
    if (this.extra) this.contentEl.createEl("p", { text: this.extra, cls: "mod-warning" });
    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    const cancel = nav.createEl("button", { text: "Cancel" }); cancel.onclick = () => this.close();
    nav.createEl("button", { text: "Delete", cls: "mod-warning" }).onclick = () => { this.close(); this.onDelete(); };
    cancel.focus();
  }
}

export class TicketSuggestModal extends FuzzySuggestModal<Ticket | null> {
  constructor(private plugin: SamayaPlugin, private choose: (t: Ticket | null) => void, private fits: (t: Ticket) => boolean = () => true, private includeDone = false, placeholder = "Assign to ticket…") {
    super(plugin.app); this.setPlaceholder(placeholder);
  }
  getItems() { return allTickets(this.app, this.plugin.settings).filter(t => (this.includeDone || !isDoneState(t.state)) && this.fits(t)); }
  getItemText(t: Ticket | null) { return t ? `${t.key}  ${t.summary}` : "(no ticket)"; }
  onChooseItem(t: Ticket | null) { this.choose(t); }
}

/** Pick the meeting a task is assigned to (newest first). */
export class MeetingSuggestModal extends FuzzySuggestModal<ReturnType<typeof allMeetings>[number]> {
  constructor(private plugin: SamayaPlugin, private choose: (f: TFile) => void) { super(plugin.app); this.setPlaceholder("Assign to meeting…"); }
  getItems() { return allMeetings(this.app, this.plugin.settings); }
  getItemText(m: ReturnType<typeof allMeetings>[number]) { return meetingLabel(m); }
  onChooseItem(m: ReturnType<typeof allMeetings>[number]) { this.choose(m.file); }
}

/** Pick an open task to assign to a meeting (`fits` hides the ones already assigned to it). */
export class TaskSuggestModal extends FuzzySuggestModal<Task> {
  constructor(private plugin: SamayaPlugin, private choose: (t: Task) => void, private fits: (t: Task) => boolean = () => true) { super(plugin.app); this.setPlaceholder("Assign task…"); }
  getItems() { return allTasks(this.app, this.plugin.settings).filter(t => t.status !== "done" && this.fits(t)).sort((a, b) => a.title.localeCompare(b.title)); }
  getItemText(t: Task) { return t.title; }
  onChooseItem(t: Task) { this.choose(t); }
}

/** A single ticket, or a whole Jira / GitLab project (its tickets not yet linked to the chosen project). */
export type TicketTarget = { kind: "ticket"; ticket: Ticket } | { kind: "project"; name: string; tickets: Ticket[] };
export class TicketTargetSuggestModal extends FuzzySuggestModal<TicketTarget> {
  constructor(private plugin: SamayaPlugin, private projectPath: string, private choose: (t: TicketTarget) => void) { super(plugin.app); this.setPlaceholder("Link to a ticket or a Jira / GitLab project…"); }
  getItems(): TicketTarget[] {
    const open = allTickets(this.app, this.plugin.settings).filter(t => projectPathOf(this.app, t.file) !== this.projectPath);
    const by = new Map<string, Ticket[]>(); // keyed by source + project, since ids can repeat across Jira and GitLab
    for (const t of open) if (t.project) { const k = `${t.source}\n${t.project}`; (by.get(k) ?? by.set(k, []).get(k)!).push(t); }
    return [...[...by.values()].map((tickets): TicketTarget => ({ kind: "project", name: tickets[0].project, tickets })), ...open.map((ticket): TicketTarget => ({ kind: "ticket", ticket }))];
  }
  getItemText(t: TicketTarget) { return t.kind === "project" ? `${SOURCE_NAMES[t.tickets[0]?.source] ?? "Ticket"} project ${t.name} (${t.tickets.length} ticket${t.tickets.length === 1 ? "" : "s"})` : `${t.ticket.key}  ${t.ticket.summary}`; }
  onChooseItem(t: TicketTarget) { this.choose(t); }
}

/** Pick a project, or type a name that matches none and create it on the spot (the new project is what `choose` receives). */
type ProjectChoice = { project: Project } | { create: string };
export class ProjectSuggestModal extends SuggestModal<ProjectChoice> {
  constructor(private plugin: SamayaPlugin, private choose: (p: Project) => void, private fits: (p: Project) => boolean = () => true) { super(plugin.app); this.setPlaceholder("Assign to project… (type a new name to create one)"); }
  getSuggestions(query: string): ProjectChoice[] {
    const q = query.trim(); const match = q ? prepareFuzzySearch(q) : null;
    const scored = allProjects(this.app, this.plugin.settings).filter(p => !p.done && this.fits(p))
      .map(p => ({ p, score: match ? match(projectLabel(p.name, p.usecase))?.score : 0 })).filter((x): x is { p: Project; score: number } => x.score != null)
      .sort((a, b) => b.score - a.score);
    const out: ProjectChoice[] = scored.map(x => ({ project: x.p }));
    const exact = allProjects(this.app, this.plugin.settings).some(p => p.name.toLowerCase() === q.toLowerCase());
    if (q && !exact) out.push({ create: q });
    return out;
  }
  renderSuggestion(c: ProjectChoice, el: HTMLElement) { el.setText("project" in c ? projectLabel(c.project.name, c.project.usecase) : `Create project “${c.create}”`); }
  onChooseSuggestion(c: ProjectChoice) {
    if ("project" in c) { this.choose(c.project); return; }
    void createProject(this.app, this.plugin.settings, c.create).then(f => { this.plugin.bus.emit(); this.choose(readProject(this.app, f)); });
  }
}

/** Asked when moving a segment of a split task makes it possible to join the pieces again. */
export class MergeSegmentsModal extends Modal {
  private answered = false;
  constructor(plugin: SamayaPlugin, private total: number, private answer: (merge: boolean) => void) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText("Merge the split task?");
    this.contentEl.createEl("p", { text: `The pieces now fit together. Merge them into one block of ${fmtDur(this.total)}?` });
    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    const done = (v: boolean) => { this.answered = true; this.close(); this.answer(v); };
    nav.createEl("button", { text: "Keep split" }).onclick = () => done(false);
    const ok = nav.createEl("button", { text: "Merge", cls: "mod-cta" }); ok.onclick = () => done(true); ok.focus();
  }
  onClose() { if (!this.answered) { this.answered = true; this.answer(false); } }
}

export interface TicketTaskResult { /** "" = the ticket title */ name: string; /** minutes, null = the default estimate */ estimate: number | null; /** "week", "today" or a backlog horizon */ when: "week" | "today" | Horizon; }
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

/** New task for a ticket: name (empty = the ticket's title), duration and where the task goes (this week, today or a backlog section). */
export class TicketTaskModal extends Modal {
  constructor(private plugin: SamayaPlugin, private key: string, private ticketTitle: string, private onSubmit: (r: TicketTaskResult) => void) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText(`New task for ${this.key}`);
    const field = (label: string) => { const r = this.contentEl.createDiv("samaya-modal-field"); r.createDiv({ cls: "samaya-modal-label", text: label }); return r; };
    const name = field("Name").createEl("input", { type: "text", attr: { placeholder: this.ticketTitle } });
    this.contentEl.createDiv({ cls: "samaya-modal-hint", text: "Leave empty to use the ticket title." });

    const dur = field("Duration"); const dsel = dur.createEl("select", { cls: "dropdown" });
    dsel.createEl("option", { value: "", text: `Default (${fmtDur(this.plugin.settings.defaultEstimate)})` });
    DURATIONS.forEach(m => dsel.createEl("option", { value: String(m), text: fmtDur(m) }));
    dsel.createEl("option", { value: "custom", text: "Custom…" });
    const custom = dur.createEl("input", { type: "text", cls: "samaya-modal-custom", attr: { placeholder: "e.g. 1:30, 1.5h, 90m" } }); custom.hide();
    dsel.addEventListener("change", () => { if (dsel.value === "custom") { custom.show(); custom.focus(); } else custom.hide(); });

    const whenSel = field("Schedule").createEl("select", { cls: "dropdown" });
    whenSel.createEl("option", { value: "week", text: "This week" });
    whenSel.createEl("option", { value: "today", text: "Today" });
    HORIZONS.forEach(([h, label]) => whenSel.createEl("option", { value: h, text: `Backlog: ${label}` }));

    const go = () => {
      let estimate: number | null = null;
      if (dsel.value === "custom") { estimate = parseDuration(custom.value); if (!estimate || estimate <= 0) { custom.addClass("is-invalid"); custom.focus(); return; } }
      else if (dsel.value) estimate = Number(dsel.value);
      this.close(); this.onSubmit({ name: name.value.trim(), estimate, when: whenSel.value as TicketTaskResult["when"] });
    };
    for (const el of [name, custom]) el.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) go(); });
    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    nav.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    nav.createEl("button", { text: "Create task", cls: "mod-cta" }).onclick = go;
    name.focus();
  }
}

/** "There is no quarterly note for Q4 2026 yet - create it?" (switching a note to another kind found nothing to open) */
export class ConfirmCreatePeriodModal extends Modal {
  constructor(plugin: SamayaPlugin, private noun: string, private name: string, private onCreate: () => void) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText(`No ${this.noun} note yet`);
    this.contentEl.createEl("p", { text: `There is no ${this.noun} note for ${this.name} yet.` });
    this.contentEl.createEl("p", { text: `Do you want to create one?` });
    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    nav.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = nav.createEl("button", { text: "Create", cls: "mod-cta" });
    ok.onclick = () => { this.close(); this.onCreate(); };
    ok.focus();
  }
}

/** Correct the breaks of one day: change times, switch lunch/break, remove or add. */
export class EditBreaksModal extends Modal {
  private rows: Break[];
  constructor(private plugin: SamayaPlugin, private date: string, breaks: Break[], private openBreak: { start: string; kind: BreakKind } | null = null) {
    super(plugin.app); this.rows = breaks.map(b => ({ ...b }));
  }
  onOpen() {
    this.titleEl.setText(`Breaks on ${this.date}`);
    this.render();
  }
  private render() {
    const c = this.contentEl; c.empty();
    if (this.openBreak) c.createEl("p", { cls: "samaya-dash-note", text: `A break since ${this.openBreak.start} is still running - end it first with "Back to work".` });
    const list = c.createDiv("samaya-brk-list");
    if (!this.rows.length) list.createDiv({ cls: "samaya-dash-note", text: "No breaks logged." });
    this.rows.forEach((b, i) => {
      const row = list.createDiv("samaya-brk-row");
      const t = (v: string, set: (v: string) => void) => { const el = row.createEl("input", { type: "time" }); el.value = v; el.onchange = () => { if (el.value) set(el.value); }; };
      t(b.start, v => { b.start = v; }); row.createSpan({ text: "–" }); t(b.end, v => { b.end = v; });
      const sel = row.createEl("select"); (["break", "lunch"] as BreakKind[]).forEach(k => sel.createEl("option", { text: k, value: k })); sel.value = b.kind; sel.onchange = () => { b.kind = sel.value as BreakKind; };
      const del = row.createEl("button", { text: "✕", attr: { "aria-label": "Remove this break" } }); del.onclick = () => { this.rows.splice(i, 1); this.render(); };
    });
    const nav = c.createDiv("samaya-ritual-nav");
    nav.createEl("button", { text: "Add break" }).onclick = () => { this.rows.push({ start: "12:00", end: "12:30", kind: "break" }); this.render(); };
    nav.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = () => void this.save();
  }
  private async save() {
    const bad = this.rows.find(b => hmToMin(b.end) <= hmToMin(b.start));
    if (bad) { new Notice(`Samaya: a break must end after it starts (${bad.start}-${bad.end}).`); return; }
    this.close(); await this.plugin.workday.setBreaks(this.date, this.rows);
  }
}

/** Log work outside the workday (evening, weekend). It counts as work time on top of the day, independent of its start and end. */
export class EditExtraModal extends Modal {
  private rows: Extra[];
  constructor(private plugin: SamayaPlugin, private date: string, extra: Extra[]) { super(plugin.app); this.rows = extra.map(e => ({ ...e })); }
  onOpen() { this.titleEl.setText(`Extra work time on ${this.date}`); this.render(); }
  private render() {
    const c = this.contentEl; c.empty();
    c.createEl("p", { cls: "samaya-dash-note", text: "Work done outside the workday, e.g. in the evening or at the weekend. Counts as work time, independent of the day's start and end." });
    const list = c.createDiv("samaya-brk-list");
    if (!this.rows.length) list.createDiv({ cls: "samaya-dash-note", text: "No extra work logged." });
    this.rows.forEach((e, i) => {
      const row = list.createDiv("samaya-brk-row");
      const t = (v: string, set: (v: string) => void) => { const el = row.createEl("input", { type: "time" }); el.value = v; el.onchange = () => { if (el.value) set(el.value); }; };
      t(e.start, v => { e.start = v; }); row.createSpan({ text: "–" }); t(e.end, v => { e.end = v; });
      row.createEl("button", { text: "✕", attr: { "aria-label": "Remove this entry" } }).onclick = () => { this.rows.splice(i, 1); this.render(); };
    });
    const nav = c.createDiv("samaya-ritual-nav");
    nav.createEl("button", { text: "Add time" }).onclick = () => { this.rows.push({ start: "19:00", end: "20:00" }); this.render(); };
    nav.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = () => void this.save();
  }
  private async save() {
    const bad = this.rows.find(e => hmToMin(e.end) <= hmToMin(e.start));
    if (bad) { new Notice(`Samaya: an entry must end after it starts (${bad.start}-${bad.end}).`); return; }
    this.close(); await this.plugin.workday.setExtra(this.date, this.rows);
  }
}
