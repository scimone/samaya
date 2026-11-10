import { FuzzySuggestModal, Modal } from "obsidian";
import type SamayaPlugin from "./main";
import { Project, allProjects } from "./projects";
import { Ticket, allTickets } from "./model";
import { fmtDur } from "./util";

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

/** New task for a ticket: leaving the field empty takes the ticket's title as the task name. An estimate like "1h" can be typed on its own or after a title. */
export class TicketTaskModal extends Modal {
  constructor(plugin: SamayaPlugin, private key: string, private ticketTitle: string, private onSubmit: (raw: string) => void) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText(`New task for ${this.key}`);
    this.contentEl.createEl("p", { text: "Task name. Leave empty to use the ticket title. Append 30m / 1h for an estimate." });
    const inp = this.contentEl.createEl("input", { type: "text", attr: { placeholder: this.ticketTitle } }); inp.style.width = "100%"; inp.focus();
    const go = () => { const v = inp.value.trim(); this.close(); this.onSubmit(v); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) go(); });
    const nav = this.contentEl.createDiv("samaya-ritual-nav");
    nav.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    nav.createEl("button", { text: "Create task", cls: "mod-cta" }).onclick = go;
  }
}
