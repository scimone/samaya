import { App, Menu, TFile } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, addSubtask, assignTicket, patchTask, readSubtasks, readTicket, setDone, ticketPathOf, toggleSubtask } from "../model";
import { ProjectSuggestModal, TicketSuggestModal } from "../modals";
import { assignProject, projectPathOf } from "../projects";
import { fmtHm, parseDuration, startOfWeek, today } from "../util";

export interface CardOpts {
  scope: DndScope; showTime?: boolean; /** show the actions under the estimate on the right instead of below the title */ actionsSide?: boolean; /** hide subtasks (sidebar) */ compact?: boolean;
  /** extra quick-action buttons (label, handler) */ actions?: Array<[string, () => void]>;
}

export function renderTaskCard(plugin: SamayaPlugin, parent: HTMLElement, t: Task, o: CardOpts): HTMLElement {
  const app: App = plugin.app;
  const el = parent.createDiv({ cls: "samaya-card" + (t.status === "done" ? " is-done" : "") });
  el.dataset.path = t.file.path;
  const row = el.createDiv("samaya-card-row");
  const body = row.createDiv("samaya-card-body");
  if (o.showTime && t.start) body.createDiv({ cls: "samaya-card-time", text: t.start });
  const line = body.createDiv("samaya-card-line");
  const cb = line.createEl("input", { type: "checkbox", cls: "samaya-check" }); cb.checked = t.status === "done";
  cb.addEventListener("change", () => { void setDone(app, t, cb.checked); });
  const title = line.createDiv({ cls: "samaya-card-title", text: t.title });
  title.addEventListener("click", e => { void app.workspace.getLeaf(e.ctrlKey || e.metaKey ? "tab" : false).openFile(t.file); });
  const meta = body.createDiv("samaya-card-meta");
  const tp = ticketPathOf(app, t);
  if (tp) {
    const tf = app.vault.getAbstractFileByPath(tp);
    if (tf instanceof TFile) { const tk = readTicket(app, tf); line.createSpan({ cls: `samaya-chip samaya-chip-ticket is-${tk.source}`, text: tk.key, attr: { title: tk.summary } }); }
  }
  if (plugin.settings.projectsOn) {
    const pp = projectPathOf(app, t.file);
    if (pp) meta.createSpan({ cls: "samaya-chip samaya-chip-project", text: pp.split("/").pop()!.replace(/\.md$/, "") });
  }
  if (t.channel) meta.createSpan({ cls: "samaya-chip samaya-chip-channel", text: t.channel });
  if (!o.actionsSide) o.actions?.forEach(([label, fn]) => { const b = meta.createEl("button", { cls: "samaya-mini", text: label }); b.addEventListener("click", fn); });
  if (!meta.childElementCount) meta.remove();

  // top right: [logged/]estimated as hh:mm
  const label = t.actual ? `${fmtHm(t.actual)}/${t.estimate ? fmtHm(t.estimate) : "--:--"}` : t.estimate ? fmtHm(t.estimate) : "--:--";
  const side = row.createDiv("samaya-card-side");
  const est = side.createEl("button", { cls: "samaya-est", text: label, attr: { title: "Estimated time (hh:mm). Click to edit" } });
  est.addEventListener("click", e => {
    e.stopPropagation();
    const input = createEl("input", { type: "text", cls: "samaya-est-input" }); input.value = fmtHm(t.estimate || plugin.settings.defaultEstimate);
    est.replaceWith(input); input.focus(); input.select();
    let done = false;
    input.addEventListener("blur", () => { if (done) return; done = true; const v = parseDuration(input.value); void patchTask(app, t.file, { estimate: v && v > 0 ? v : null }); });
    input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); if (ev.key === "Escape") { done = true; input.replaceWith(est); } });
  });

  if (o.actionsSide) o.actions?.forEach(([label, fn]) => { side.createEl("button", { cls: "samaya-mini", text: label }).addEventListener("click", fn); });

  if (!o.compact) void renderSubtasks(plugin, el.createDiv("samaya-subs"), t.file);
  else el.addClass("is-compact");

  el.addEventListener("contextmenu", e => showTaskMenu(plugin, t, e));

  o.scope.draggable(el, t.file.path);
  return el;
}

/** The right-click menu shared by task cards and timeline blocks. */
export function showTaskMenu(plugin: SamayaPlugin, t: Task, e: MouseEvent) {
  const app: App = plugin.app; const tp = ticketPathOf(app, t);
  e.preventDefault(); const m = new Menu();
  m.addItem(i => i.setTitle("Start focus").setIcon("timer").onClick(() => { void plugin.focus.start(t.file); }));
  m.addItem(i => i.setTitle(tp ? "Change ticket…" : "Assign ticket…").setIcon("ticket").onClick(() => new TicketSuggestModal(plugin, tk => { void assignTicket(app, t.file, tk); }).open()));
  if (tp) m.addItem(i => i.setTitle("Remove ticket").setIcon("unlink").onClick(() => { void assignTicket(app, t.file, null); }));
  if (plugin.settings.projectsOn) {
    const has = !!projectPathOf(app, t.file);
    m.addItem(i => i.setTitle(has ? "Change project…" : "Assign project…").setIcon("folder-kanban").onClick(() => new ProjectSuggestModal(plugin, pr => { void assignProject(app, t.file, pr); }).open()));
    if (has) m.addItem(i => i.setTitle("Remove project").setIcon("unlink").onClick(() => { void assignProject(app, t.file, null); }));
  }
  m.addSeparator();
  m.addItem(i => i.setTitle("Plan for today").setIcon("sun").onClick(() => { void patchTask(app, t.file, { planned: today(), week: null }); }));
  m.addItem(i => i.setTitle("Plan for this week").setIcon("calendar-range").onClick(() => { void patchTask(app, t.file, { planned: null, start: null, week: startOfWeek(today()) }); }));
  if (t.start) m.addItem(i => i.setTitle("Remove from timeline").setIcon("x").onClick(() => { void patchTask(app, t.file, { start: null }); }));
  if (t.planned || t.week) m.addItem(i => i.setTitle("Move to backlog").setIcon("inbox").onClick(() => { void patchTask(app, t.file, { planned: null, start: null, week: null }); }));
  m.addSeparator();
  m.addItem(i => i.setTitle("Open note").setIcon("file").onClick(() => { void app.workspace.getLeaf("tab").openFile(t.file); }));
  m.showAtMouseEvent(e);
}

export async function renderSubtasks(plugin: SamayaPlugin, host: HTMLElement, file: TFile) {
  const app = plugin.app;
  const paint = async () => {
    if (!host.isConnected) return;
    const subs = await readSubtasks(app, file);
    host.empty();
    subs.forEach(s => {
      const r = host.createDiv({ cls: "samaya-sub-row" + (s.done ? " is-done" : "") });
      const c = r.createEl("input", { type: "checkbox" }); c.checked = s.done;
      c.addEventListener("change", () => { void toggleSubtask(app, file, s.line, c.checked); });
      r.createSpan({ text: s.text });
    });
    const add = host.createEl("input", { type: "text", cls: "samaya-sub-add", attr: { placeholder: "+ Add subtask" } });
    add.addEventListener("keydown", e => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      const v = add.value.trim(); add.value = ""; void addSubtask(app, file, v);
    });
  };
  await paint();
  const ref = app.metadataCache.on("changed", f => {
    if (!host.isConnected) { app.metadataCache.offref(ref); return; }
    if (f.path === file.path) void paint();
  });
}

/** Highlight a container while hovered by a drag. */
export function bindZone(scope: DndScope, el: HTMLElement, onDrop: (path: string) => void) {
  scope.target(el, { over: () => el.addClass("is-drop"), leave: () => el.removeClass("is-drop"), drop: i => { el.removeClass("is-drop"); onDrop(i.path); } });
}
/** Insert-before/after behaviour on a card. */
export function bindCardDrop(scope: DndScope, card: HTMLElement, onDrop: (path: string, after: boolean) => void) {
  const clear = () => { card.removeClass("drop-before"); card.removeClass("drop-after"); };
  const isAfter = (y: number) => { const r = card.getBoundingClientRect(); return y > r.top + r.height / 2; };
  scope.target(card, {
    over: i => { const a = isAfter(i.y); card.toggleClass("drop-after", a); card.toggleClass("drop-before", !a); },
    leave: clear, drop: i => { const a = isAfter(i.y); clear(); onDrop(i.path, a); },
  });
}
