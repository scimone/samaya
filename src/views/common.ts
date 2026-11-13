import { App, Menu, TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { openFileSmart } from "../openfile";
import { DndScope, DropInfo } from "../dnd";
import { Source, Task, addSubtask, assignTicket, patchTask, readSubtasks, readTicket, sendPiece, setDone, setPartEstimate, ticketPathOf, toggleSubtask, unscheduleDay } from "../model";
import { ConfirmDeleteModal, ProjectSuggestModal, TicketSuggestModal } from "../modals";
import { focusButton, isCurrentTask, trackedBefore, joinParts, splitTitle } from "./place";
import { PartsModal } from "./partsModal";
import { assignProject, projectPathOf } from "../projects";
import { HORIZONS, Horizon, bucketOf, fmtDur, fmtHm, minToHm, parseDuration, parseYmd, startOfWeek, today } from "../util";

export interface CardOpts {
  scope: DndScope; showTime?: boolean; /** show the actions under the estimate on the right instead of below the title */ actionsSide?: boolean; /** hide subtasks (sidebar) */ compact?: boolean;
  /** a chip with the day the task is planned for */ dayLabel?: string;
  /** Focus button: on the ongoing task only, or on every task planned for today; the ongoing task is always lit */ focus?: "ongoing" | "today";
  /** show the scissors (split into parts): only in the Timebox and Schedule steps */ split?: boolean;
  /** extra quick-action buttons (label, handler) */ actions?: Array<[string, () => void]>;
}

/**
 * Make a non-button element usable from the keyboard: it joins the tab order, is announced as `role` with `label`, and Enter / Space run `run`.
 * Only keys pressed on the element itself count, so a nested control (the done circle in a timeline block) keeps its own keys.
 */
let srId = 0;
export function keyActivate(el: HTMLElement, label: string, run: () => void, role = "button") {
  // the accessible name is a visually hidden text, not an aria-label: Obsidian would show an aria-label as a tooltip
  const sr = el.createSpan({ cls: "samaya-sr", text: label }); sr.id = `samaya-sr-${++srId}`;
  el.setAttr("role", role); el.setAttr("tabindex", "0"); el.setAttr("aria-labelledby", sr.id);
  el.addEventListener("keydown", e => { if (e.target !== el || (e.key !== "Enter" && e.key !== " ")) return; e.preventDefault(); run(); });
}

/** Fill `el` with text where `backticked` words (button names) are shown as inline code. */
export function richText(el: HTMLElement, text: string) {
  text.split("`").forEach((part, i) => { if (!part) return; if (i % 2) el.createEl("code", { cls: "samaya-btn-ref", text: part }); else el.appendText(part); });
}

/** Ticket id chip: click opens the ticket note, hover previews it (Page preview), otherwise shows the full ticket title. */
function ticketChip(plugin: SamayaPlugin, host: HTMLElement, tf: TFile) {
  const app: App = plugin.app; const tk = readTicket(app, tf);
  const chip = host.createSpan({ cls: `samaya-chip samaya-chip-ticket is-${tk.source}` });
  setIcon(chip.createSpan({ cls: "samaya-chip-icon" }), "ticket"); chip.createSpan({ text: tk.key }); // the icon of the Tickets entry in the navigation
  const preview = !!(app as unknown as { internalPlugins?: { plugins?: Record<string, { enabled?: boolean }> } }).internalPlugins?.plugins?.["page-preview"]?.enabled;
  if (preview) {
    const parent = { hoverPopover: null };
    chip.addEventListener("mouseover", e => { app.workspace.trigger("hover-link", { event: e, source: "preview", hoverParent: parent, targetEl: chip, linktext: tf.path }); });
  } else chip.title = tk.summary ? `${tk.key}: ${tk.summary}` : tk.key;
  chip.addEventListener("click", e => { e.stopPropagation(); void openFileSmart(app, tf, e.ctrlKey || e.metaKey ? "tab" : false); });
  chip.addEventListener("pointerdown", e => e.stopPropagation());
}

/** A task on a day (and not done) can be split. */
export const canSplit = (t: Task): boolean => !!t.planned && t.status !== "done" && t.part?.kind !== "rest";

/** Chip of a task that is planned in parts: where its other parts are (click: jump to that day). */
function partChip(plugin: SamayaPlugin, meta: HTMLElement, t: Task) {
  const p = t.part!; const bits = p.others.map(o => `${parseYmd(o.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}, ${fmtDur(o.dur)}`);
  if (p.kind === "day" && p.rest) bits.push(`${fmtDur(p.rest)} left`);
  if (p.kind === "rest") bits.unshift(`of ${fmtDur(p.total)}`);
  const chip = meta.createSpan({ cls: "samaya-chip samaya-chip-split", attr: { title: splitTitle(t) } });
  setIcon(chip.createSpan({ cls: "samaya-chip-icon" }), "scissors"); chip.createSpan({ text: bits.join(" · ") });
  const go = p.others[0]?.date;
  if (go && p.kind === "day") { chip.addClass("is-link"); chip.title = `${splitTitle(t)}\nClick to open ${go}`; chip.addEventListener("click", e => { e.stopPropagation(); plugin.plannerGoTo?.(go); }); chip.addEventListener("pointerdown", e => e.stopPropagation()); }
}

export function renderTaskCard(plugin: SamayaPlugin, parent: HTMLElement, t: Task, o: CardOpts): HTMLElement {
  const app: App = plugin.app;
  const el = parent.createDiv({ cls: "samaya-card" + (t.status === "done" ? " is-done" : "") });
  el.dataset.path = t.file.path; el.dataset.day = t.planned; el.dataset.link = t.file.path; // (link: hovering a card lights up its timeline block, and the other way round)
  const row = el.createDiv("samaya-card-row");
  const body = row.createDiv("samaya-card-body");
  // eyebrow above the title, aligned with the title text: [day ·] start time (a split task lists all its time slots)
  const time = o.showTime && t.start ? (t.segments.length > 1 ? t.segments.map(g => `${minToHm(g.s)}-${minToHm(g.s + g.dur)}`).join(", ") : t.start) : "";
  if (time || o.dayLabel) { const eb = body.createDiv("samaya-card-eyebrow"); if (o.dayLabel) eb.createSpan({ cls: "samaya-card-day", text: o.dayLabel }); if (time) eb.createSpan({ cls: "samaya-card-time", text: time }); }
  const line = body.createDiv("samaya-card-line");
  const cb = line.createEl("input", { type: "checkbox", cls: "samaya-check" }); cb.checked = t.status === "done";
  cb.addEventListener("change", () => { void setDone(app, t, cb.checked); });
  const title = line.createDiv({ cls: "samaya-card-title", text: t.title });
  title.addEventListener("click", e => { void openFileSmart(app, t.file, e.ctrlKey || e.metaKey ? "tab" : false); });
  keyActivate(title, `Open task: ${t.title}`, () => { void openFileSmart(app, t.file, false); }, "link");

  // duration pill at the end of the title line: [logged/]estimated as hh:mm, filled like a progress bar
  const estTxt = t.estimate ? fmtHm(t.estimate) : "--:--";
  const dayActual = Math.max(0, t.actual - trackedBefore(plugin, t, t.planned || today())); // this day's tracked time only
  const shown = dayActual + plugin.focus.liveMin(t.file.path); // the focused task also counts its running session
  const est = line.createEl("button", { cls: "samaya-est", text: shown ? `${fmtHm(shown)}/${estTxt}` : estTxt, attr: { title: "Estimated time (hh:mm). Click to edit" } });
  est.style.setProperty("--p", `${t.estimate ? Math.min(100, (shown / t.estimate) * 100) : 0}%`); est.toggleClass("is-over", !!t.estimate && shown > t.estimate); est.toggleClass("is-empty", !t.estimate);
  if (plugin.focus.state?.path === t.file.path) { est.dataset.focusBase = String(dayActual); est.dataset.focusEst = estTxt; est.dataset.focusMin = String(t.estimate || 0); }
  est.title = t.part ? (t.part.kind === "rest" ? `Not planned yet: ${fmtDur(t.estimate)} of ${fmtDur(t.part.total)}. Click to edit` : `This part: ${fmtDur(t.estimate)} of ${fmtDur(t.part.total)}. Click to edit`) : est.title;
  est.addEventListener("click", e => {
    e.stopPropagation();
    const input = createEl("input", { type: "text", cls: "samaya-est-input" }); input.value = fmtHm(t.estimate || plugin.settings.defaultEstimate);
    est.replaceWith(input); input.focus(); input.select();
    let done = false;
    input.addEventListener("blur", () => { if (done) return; done = true; const v = parseDuration(input.value); void setPartEstimate(app, t, v && v > 0 ? v : null); });
    input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); if (ev.key === "Escape") { done = true; input.replaceWith(est); } });
  });

  // context row under the title: ticket, project, channel, split parts
  const meta = body.createDiv("samaya-card-meta");
  const tp = ticketPathOf(app, t);
  if (tp) {
    const tf = app.vault.getAbstractFileByPath(tp);
    if (tf instanceof TFile) ticketChip(plugin, meta, tf);
  }
  if (plugin.settings.projectsOn) {
    const pp = projectPathOf(app, t.file);
    if (pp) { const pc = meta.createSpan({ cls: "samaya-chip samaya-chip-project" }); setIcon(pc.createSpan({ cls: "samaya-chip-icon" }), "folder-kanban"); pc.createSpan({ text: pp.split("/").pop()!.replace(/\.md$/, "") }); }
  }
  if (t.channel) meta.createSpan({ cls: "samaya-chip samaya-chip-channel", text: t.channel });
  if (t.part) partChip(plugin, meta, t);
  if (!meta.childElementCount) meta.remove();

  if (plugin.focus.state && isCurrentTask(plugin, t)) el.addClass("is-current"); // the focused task is lit on every card, with or without a Focus button

  const subs = !o.compact ? body.createDiv("samaya-subs") : null;
  if (!subs) el.addClass("is-compact");

  // footer: "+ Add subtask" on the left, the card's actions on the right (one row, so the card gets no extra height)
  const foot = el.createDiv("samaya-card-foot");
  const acts = foot.createDiv("samaya-card-actions");
  const ICONS: Record<string, string> = { Today: "sun", Week: "calendar-days", "This week": "calendar-days" };
  o.actions?.forEach(([label, fn]) => {
    const b = acts.createEl("button", { cls: "samaya-mini samaya-act" });
    if (ICONS[label]) setIcon(b.createSpan({ cls: "samaya-act-icon" }), ICONS[label]);
    b.createSpan({ text: label });
    b.addEventListener("pointerdown", e => e.stopPropagation()); // not a drag
    b.addEventListener("click", e => { e.stopPropagation(); fn(); });
  });
  if (o.split && canSplit(t)) { // scissors: cut the task into parts, here or on other days
    const cut = acts.createEl("button", { cls: "samaya-mini samaya-split-btn", attr: { "aria-label": "Split into parts" } });
    setIcon(cut, "scissors");
    cut.addEventListener("pointerdown", e => e.stopPropagation()); // not a drag
    cut.addEventListener("click", e => { e.stopPropagation(); new PartsModal(plugin, t, "split").open(); });
  }
  if (o.focus) {
    const on = isCurrentTask(plugin, t); if (on) el.addClass("is-current");
    if (on || (o.focus === "today" && t.planned === today() && t.status !== "done")) focusButton(plugin, acts, t);
  }
  if (subs) void renderSubtasks(plugin, subs, t.file, t.status !== "done", foot);
  if (!acts.childElementCount) acts.remove();
  if (!foot.childElementCount) foot.remove();

  el.addEventListener("contextmenu", e => showTaskMenu(plugin, t, e, null, !!o.split));

  o.scope.draggable(el, t.file.path);
  return el;
}

/** Backlog tasks grouped under Next week / Next month / Next quarter / Next year / Someday / Never; every group is a drop zone that parks the dragged task there. */
export function renderBacklogBuckets(plugin: SamayaPlugin, host: HTMLElement, tasks: Task[], scope: DndScope, o: { compact?: boolean; actionsSide?: boolean; actions?: (t: Task) => Array<[string, () => void]> }, cls = { label: "samaya-today-label", list: "samaya-today-cards", empty: "samaya-today-empty" }) {
  const from = today();
  const groups: Array<[Horizon, string, Task[]]> = HORIZONS.map(([h, label]) => [h, label, tasks.filter(t => bucketOf(t.horizon, t.later, from) === h)]);
  for (const [h, label, ts] of groups) {
    const box = host.createDiv("samaya-bucket");
    box.createDiv({ cls: cls.label, text: `${label} · ${ts.length}` });
    const list = box.createDiv(cls.list);
    if (!ts.length) list.createDiv({ cls: cls.empty, text: "Drop a task here" });
    ts.forEach(t => renderTaskCard(plugin, list, t, { compact: o.compact, actionsSide: o.actionsSide, actions: o.actions?.(t), scope }));
    bindZone(scope, box, (path, i) => { const f = plugin.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) void sendPiece(plugin.app, plugin.settings, f, i, { backlog: h }); });
  }
}

/** Ticket entries of the task menu: assign / change / remove. */
export function addTicketItems(m: Menu, plugin: SamayaPlugin, t: Task) {
  const app = plugin.app; const tp = ticketPathOf(app, t); const ticketsOn = plugin.settings.jiraOn || plugin.settings.gitlabOn;
  if (ticketsOn || tp) m.addItem(i => i.setTitle(tp ? "Change ticket…" : "Assign ticket…").setIcon("ticket").onClick(() => new TicketSuggestModal(plugin, tk => { void assignTicket(app, t.file, tk); }).open()));
  if (tp && ticketsOn) m.addItem(i => i.setTitle("Remove ticket").setIcon("unlink").onClick(() => { void assignTicket(app, t.file, null); }));
}
/** Project entries of the task menu: assign / change / remove. */
export function addProjectItems(m: Menu, plugin: SamayaPlugin, t: Task) {
  const app = plugin.app;
  if (!plugin.settings.projectsOn) return;
  const has = !!projectPathOf(app, t.file);
  m.addItem(i => i.setTitle(has ? "Change project…" : "Assign project…").setIcon("folder-kanban").onClick(() => new ProjectSuggestModal(plugin, pr => { void assignProject(app, t.file, pr); }).open()));
  if (has) m.addItem(i => i.setTitle("Remove project").setIcon("unlink").onClick(() => { void assignProject(app, t.file, null); }));
}
/** Planning entries of the task menu: split / move, plan for today or this week, back to the timeline's edge, backlog buckets. `seg`: the piece of a split day that was clicked (timeline blocks). */
export function addPlanItems(m: Menu, plugin: SamayaPlugin, t: Task, seg: number | null = null, canCut = false) {
  const app: App = plugin.app; const st = plugin.settings;
  const from: Source = { day: t.planned, seg };
  const part = !!t.part || t.segments.length > 1; // planned in parts: the buttons below act on this part
  const send = (dest: Parameters<typeof sendPiece>[4]) => { void sendPiece(app, st, t.file, from, dest); };
  if (canSplit(t)) {
    if (canCut) m.addItem(i => i.setTitle("Split task…").setIcon("scissors").onClick(() => new PartsModal(plugin, t, "split", seg).open()));
    m.addItem(i => i.setTitle(part ? "Move this part to another day…" : "Move to another day…").setIcon("calendar-days").onClick(() => new PartsModal(plugin, t, "move", seg).open()));
    if (part) m.addItem(i => i.setTitle("Join all parts here").setIcon("combine").onClick(() => { void joinParts(plugin, t.file, t.planned); }));
  }
  m.addItem(i => i.setTitle(part ? "Do this part today" : "Plan for today").setIcon("sun").onClick(() => send({ day: today() })));
  m.addItem(i => i.setTitle(part ? "Move this part to this week" : "Plan for this week").setIcon("calendar-range").onClick(() => send({ week: startOfWeek(today()) })));
  if (t.start) m.addItem(i => i.setTitle("Remove from timeline").setIcon("x").onClick(() => { void unscheduleDay(app, t.file, t.planned); }));
  if (t.planned || t.week) m.addItem(i => i.setTitle(part ? "Move this part to backlog" : "Move to backlog").setIcon("inbox").onClick(() => send({ backlog: "someday" })));
  HORIZONS.filter(([h]) => h !== "someday" && h !== "never").forEach(([h, label]) => m.addItem(i => i.setTitle(`Backlog: ${label.toLowerCase()}`).setIcon("calendar-clock").onClick(() => send({ backlog: h }))));
}

/** The right-click menu shared by task cards and timeline blocks. `seg`: the piece of a split day that was clicked (timeline blocks). */
export function showTaskMenu(plugin: SamayaPlugin, t: Task, e: MouseEvent, seg: number | null = null, canCut = false) {
  const app: App = plugin.app;
  e.preventDefault(); const m = new Menu();
  if (plugin.workday.started) m.addItem(i => i.setTitle("Start focus").setIcon("timer").onClick(() => { void plugin.focus.start(t.file); }));
  addTicketItems(m, plugin, t); addProjectItems(m, plugin, t);
  m.addSeparator();
  addPlanItems(m, plugin, t, seg, canCut);
  m.addSeparator();
  m.addItem(i => i.setTitle("Open note").setIcon("file").onClick(() => { void openFileSmart(app, t.file, "tab"); }));
  m.addItem(i => i.setTitle("Delete task").setIcon("trash").setWarning(true).onClick(() => { // asks first; then follows the vault's "deleted files" setting (system trash, .trash or permanent)
    new ConfirmDeleteModal(plugin, t.title, () => { void app.fileManager.trashFile(t.file).then(() => { window.setTimeout(() => plugin.bus.emit(), 150); }); }).open();
  }));
  m.showAtMouseEvent(e);
}

export async function renderSubtasks(plugin: SamayaPlugin, host: HTMLElement, file: TFile, canAdd: boolean, addHost: HTMLElement) {
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
  };
  if (canAdd) { // checked-off tasks take no new subtasks
    const add = addHost.createEl("input", { type: "text", cls: "samaya-sub-add", attr: { placeholder: "+ Add subtask" } });
    addHost.prepend(add);
    add.addEventListener("keydown", e => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      const v = add.value.trim(); add.value = ""; void addSubtask(app, file, v);
    });
  }
  await paint();
  const ref = app.metadataCache.on("changed", f => {
    if (!host.isConnected) { app.metadataCache.offref(ref); return; }
    if (f.path === file.path) void paint();
  });
}

/** Highlight a container while hovered by a drag. */
export function bindZone(scope: DndScope, el: HTMLElement, onDrop: (path: string, i: DropInfo) => void) {
  scope.target(el, { over: () => el.addClass("is-drop"), leave: () => el.removeClass("is-drop"), drop: i => { el.removeClass("is-drop"); onDrop(i.path, i); } });
}
/** Insert-before/after behaviour on a card. */
export function bindCardDrop(scope: DndScope, card: HTMLElement, onDrop: (path: string, after: boolean, i: DropInfo) => void) {
  const clear = () => { card.removeClass("drop-before"); card.removeClass("drop-after"); };
  const isAfter = (y: number) => { const r = card.getBoundingClientRect(); return y > r.top + r.height / 2; };
  scope.target(card, {
    over: i => { const a = isAfter(i.y); card.toggleClass("drop-after", a); card.toggleClass("drop-before", !a); },
    leave: clear, drop: i => { const a = isAfter(i.y); clear(); onDrop(i.path, a, i); },
  });
}
