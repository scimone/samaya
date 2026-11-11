import { FuzzySuggestModal, Modal } from "obsidian";
import type SamayaPlugin from "./main";
import { Project, allProjects } from "./projects";
import { Ticket, allTickets } from "./model";
import { HORIZONS, Horizon, fmtDur, parseDuration } from "./util";

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
  constructor(plugin: SamayaPlugin, private title: string, private onDelete: () => void) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText("Delete task?");
    this.contentEl.createEl("p", { text: `“${this.title}” will be deleted (it goes where your vault's “Deleted files” setting sends it).` });
    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    const cancel = nav.createEl("button", { text: "Cancel" }); cancel.onclick = () => this.close();
    nav.createEl("button", { text: "Delete", cls: "mod-warning" }).onclick = () => { this.close(); this.onDelete(); };
    cancel.focus();
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
