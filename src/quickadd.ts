// Keyboard-only "New task" dialog: one line with inline directives (see quickparse.ts), a live preview of what they mean
// and completion for @ # ^ & (Up / Down to choose, Tab to accept, Enter to create).
import { AbstractInputSuggest, App, Modal, Notice, TFile, prepareFuzzySearch, setIcon } from "obsidian";
import type SamayaPlugin from "./main";
import type { SamayaSettings } from "./settings";
import { allTickets, Ticket, createTask } from "./model";
import { allProjects, projectLabel, projectPathOf } from "./projects";
import { allMeetings, meetingLabel } from "./links";
import { projectChip, projectColorAt, projectUsecaseAt, ticketChip } from "./views/common";
import { addDays, fmtHm, horizonTarget, parseYmd, today } from "./util";
import { QuickTask, WHEN_WORDS, applyCompletion, parseQuick, tokenAt } from "./quickparse";
import { safe } from "./safe";

export const slug = (s: string): string => s.trim().replace(/\s+/g, "-");
const unslug = (s: string): string => s.replace(/[-_]+/g, " ").trim();
const dayLabel = (ymd: string): string => parseYmd(ymd).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** Best fuzzy match of `query` among `items` (by text), or null. */
function best<T>(items: T[], text: (t: T) => string, query: string): T | null {
  const m = prepareFuzzySearch(unslug(query)); let top: T | null = null; let score = -Infinity;
  for (const it of items) { const r = m(text(it)); if (r && r.score > score) { score = r.score; top = it; } }
  return top;
}

export interface Resolved {
  title: string; fm: Record<string, string | number>; errors: string[];
  /** what the card shows */ ticket: Ticket | null; project: TFile | null; meeting: { file: TFile; title: string } | null;
  /** what the card does not show, as pills (@today, @nextweek ...) */ pills: string[];
}

/** Turn a parsed line into the properties of the new note, looking projects, tickets and meetings up in the vault. */
const WHEN_KEYS = ["planned", "week", "later", "horizon"];
/** `base`: properties the place the task is added in already gives (a day, a position); a day typed in the line replaces its day / week / backlog keys. */
export function resolveQuick(app: App, s: SamayaSettings, q: QuickTask, base: Record<string, string | number> | null = null): Resolved {
  const errors = [...q.errors]; const pills: string[] = []; let meeting: Resolved["meeting"] = null; const fm: Record<string, string | number> = { ...base };
  const t0 = today();
  if (q.when || !base) {
    for (const k of WHEN_KEYS) delete fm[k];
    const w = q.when ?? { day: t0 };
    if ("day" in w) fm.planned = w.day;
    else if ("week" in w) fm.week = w.week;
    else { const tg = horizonTarget(w.horizon, t0); if (tg) fm.later = tg; fm.horizon = w.horizon; }
  }
  if (typeof fm.planned === "string") pills.push(fm.planned === t0 ? "@today" : fm.planned === addDays(t0, 1) ? "@tomorrow" : `@${dayLabel(fm.planned)}`);
  else if (fm.week) pills.push("@week");
  else if (fm.horizon) pills.push(fm.horizon === "week" ? "@nextweek" : `@${fm.horizon}`);
  fm.estimate = q.estimate ?? s.defaultEstimate;

  let ticket: Ticket | null = null; let project: TFile | null = null;
  if (q.ticket !== undefined) {
    if (!s.ticketsOn) errors.push("Tickets are switched off");
    else {
      const all = allTickets(app, s); const k = q.ticket.toLowerCase();
      ticket = all.find(t => t.key.toLowerCase() === k) ?? all.find(t => t.key.toLowerCase().startsWith(k)) ?? best(all, t => `${t.key} ${t.summary}`, q.ticket);
      if (!ticket) errors.push(`No ticket matches &${q.ticket}`);
    }
  }
  if (q.project !== undefined) {
    if (!s.projectsOn) errors.push("Projects are switched off");
    else {
      const open = allProjects(app, s).filter(x => !x.done);
      const p = open.find(x => slug(x.name).toLowerCase() === q.project!.toLowerCase()) ?? best(open, x => projectLabel(x.name, x.usecase), q.project);
      if (p) project = p.file; else errors.push(`No project matches #${q.project}`);
    }
  }
  // same rules as assigning later: a ticket brings its project along, a project with exactly one single ticket brings that ticket
  const tp = ticket && s.projectsOn ? projectPathOf(app, ticket.file) : "";
  if (ticket && project && tp && tp !== project.path) { errors.push(`${ticket.key} belongs to another project than ${project.basename}`); ticket = null; }
  if (ticket && !project && tp) { const f = app.vault.getAbstractFileByPath(tp); if (f instanceof TFile) project = f; }
  if (project && !ticket && !app.metadataCache.getFileCache(project)?.frontmatter?.ticket_project && q.ticket === undefined) {
    const mine = allTickets(app, s).filter(t => projectPathOf(app, t.file) === project!.path); if (mine.length === 1) ticket = mine[0];
  }
  if (project) fm.samaya_project = `[[${project.basename}]]`;
  if (ticket) fm.ticket = `[[${ticket.file.basename}]]`;

  if (q.meeting !== undefined) {
    const ms = allMeetings(app, s).filter(m => !q.meetingDate || m.date === q.meetingDate);
    const exact = ms.filter(m => slug(m.title).toLowerCase() === q.meeting!.toLowerCase());
    const hits = exact.length ? exact : ms.filter(m => best([m], x => x.title, q.meeting!)); // fuzzy matches; the one closest to today wins (a recurring meeting has many instances)
    const near = (d: string) => Math.abs(parseYmd(d).getTime() - parseYmd(t0).getTime());
    const m = hits.sort((a, b) => near(a.date) - near(b.date) || (a.start ?? 0) - (b.start ?? 0))[0];
    if (m) { fm.meeting = `[[${m.file.basename}]]`; meeting = { file: m.file, title: m.title }; } else errors.push(`No meeting matches /${q.meeting}`);
  }
  return { title: q.title, fm, errors, ticket, project, meeting, pills };
}

const NO_TITLE = "The task needs a title"; // (the card shows a placeholder title instead of this error)
interface Option { insert: string; label: string; hint?: string; }
/** Completions for the directive being typed. */
function optionsFor(app: App, s: SamayaSettings, prefix: string, query: string): Option[] {
  const m = query ? prepareFuzzySearch(unslug(query)) : null;
  const rank = <T,>(items: T[], text: (t: T) => string): T[] =>
    (m ? items.map(it => ({ it, r: m(text(it)) })).filter(x => x.r).sort((a, b) => b.r!.score - a.r!.score).map(x => x.it) : items);
  if (prefix === "@") {
    const l = query.toLowerCase(); const out = WHEN_WORDS.filter(([w, d]) => !l || w.startsWith(l) || d.toLowerCase().includes(l));
    return out.map(([w, d]) => ({ insert: `@${w}`, label: `@${w}`, hint: d }));
  }
  if (prefix === "#") return rank(allProjects(app, s).filter(p => !p.done), p => projectLabel(p.name, p.usecase)).slice(0, 8).map(p => ({ insert: `#${slug(p.name)}`, label: `#${slug(p.name)}`, hint: p.usecase ? `#${p.usecase}` : undefined }));
  if (prefix === "&") return rank(allTickets(app, s).filter(t => !/^(done|closed|resolved)/i.test(t.state)), t => `${t.key} ${t.summary}`).slice(0, 8).map(t => ({ insert: `&${t.key}`, label: `&${t.key}`, hint: t.summary }));
  const t0 = today(); const near = (d: string) => Math.abs(parseYmd(d).getTime() - parseYmd(t0).getTime());
  return rank(allMeetings(app, s), mt => mt.title).sort((a, b) => (m ? 0 : near(a.date) - near(b.date))).slice(0, 8)
    .map(mt => ({ insert: `/${slug(mt.title)}:${mt.date}`, label: `/${slug(mt.title)}`, hint: meetingLabel(mt).split("  ")[0] }));
}

/** The completions for the word at the cursor: none when no directive is being typed, its module is off, or it is already complete (then Enter creates the task). */
function suggestionsAt(app: App, s: SamayaSettings, text: string, cursor: number): Option[] {
  const t = tokenAt(text, cursor);
  if (!t || (t.prefix === "#" && !s.projectsOn) || (t.prefix === "&" && !s.ticketsOn)) return [];
  try {
    const all = optionsFor(app, s, t.prefix, t.query);
    return all.some(o => o.insert.toLowerCase() === `${t.prefix}${t.query}`.toLowerCase()) ? [] : all;
  } catch (e) { console.warn("Samaya: quick add suggestions failed", e); return []; } // never let the completion get in the way of typing
}

/** The task as a card (the one the task lists show), without its buttons; what the card does not show comes as pills. */
export function renderTaskPreview(plugin: SamayaPlugin, host: HTMLElement, r: Resolved) {
  const el = host.createDiv({ cls: "samaya-card is-compact samaya-quickadd-card" });
  const body = el.createDiv("samaya-card-row").createDiv("samaya-card-body");
  const line = body.createDiv("samaya-card-line");
  line.createEl("input", { type: "checkbox", cls: "samaya-check", attr: { disabled: "true" } });
  line.createDiv({ cls: "samaya-card-title" + (r.title ? "" : " is-placeholder"), text: r.title || "Title" });
  const est = Number(r.fm.estimate) || 0;
  const b = line.createEl("button", { cls: "samaya-est", text: est ? fmtHm(est) : "--:--", attr: { tabindex: "-1" } }); b.style.setProperty("--p", "0%"); b.style.pointerEvents = "none";
  const meta = body.createDiv("samaya-card-meta");
  if (r.ticket) ticketChip(plugin, meta, r.ticket.file);
  if (r.project) projectChip(meta, r.project.basename, projectColorAt(plugin.app, r.project.path), projectUsecaseAt(plugin.app, r.project.path));
  if (r.meeting) { const mc = meta.createSpan({ cls: "samaya-chip samaya-chip-meeting" }); setIcon(mc.createSpan({ cls: "samaya-chip-icon" }), "calendar-clock"); mc.createSpan({ text: r.meeting.title }); }
  for (const p of r.pills) meta.createSpan({ cls: "samaya-chip samaya-chip-when", text: p });
}

/** What each sign does, one line per sign. */
function renderLegend(host: HTMLElement, s: SamayaSettings, foot: string) {
  const box = host.createDiv("samaya-quickadd-legend");
  const rows: Array<[string, string, string]> = [
    ["30m", "Estimate", "25m · 1h · 1.5h · 1h30m"],
    ["@", "Day or backlog", "@today · @tomorrow · @fri · @2026-11-20 · @week · @nextweek · @someday"],
    ...(s.projectsOn ? [["#", "Project", "#website (loose match, - = space)"] as [string, string, string]] : []),
    ...(s.ticketsOn ? [["&", "Ticket", "&PROJ-123"] as [string, string, string]] : []),
    ["/", "Meeting", "/standup (the one closest to today)"],
  ];
  for (const [key, what, eg] of rows) {
    const row = box.createDiv("samaya-quickadd-legend-row");
    row.createEl("kbd", { text: key }); row.createSpan({ cls: "samaya-quickadd-legend-what", text: what }); row.createSpan({ cls: "samaya-quickadd-hint", text: eg });
  }
  box.createDiv({ cls: "samaya-quickadd-legend-foot", text: foot });
}

export class QuickAddModal extends Modal {
  private input!: HTMLInputElement; private preview!: HTMLElement; private list!: HTMLElement;
  private opts: Option[] = []; private sel = -1;
  constructor(private plugin: SamayaPlugin, private label = "New task", private initial = "", private onDone?: () => void) { super(plugin.app); }
  onOpen() {
    const { contentEl } = this; contentEl.addClass("samaya-quickadd");
    contentEl.createEl("p", { text: this.label });
    this.input = contentEl.createEl("input", { type: "text", cls: "samaya-quickadd-input", attr: { placeholder: "Title 30m @tomorrow #project &TICKET /meeting" } });
    this.list = contentEl.createDiv("samaya-quickadd-list");
    this.preview = contentEl.createDiv("samaya-quickadd-preview");
    renderLegend(contentEl, this.plugin.settings, "Enter completes a suggestion, Enter again creates the task · Esc cancels");
    this.input.value = this.initial; this.input.focus();
    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("click", () => this.refresh());
    this.input.addEventListener("keydown", e => this.onKey(e));
    this.refresh();
  }
  private onKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    const open = this.opts.length > 0;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault(); const n = this.opts.length;
      this.sel = (this.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n; this.drawList(); return;
    }
    if (open && e.key === "Tab" && !e.shiftKey) { e.preventDefault(); this.accept(Math.max(0, this.sel)); return; }
    if (e.key === "Enter") { e.preventDefault(); if (open) this.accept(Math.max(0, this.sel)); else this.submit(); } // Enter completes while a suggestion is open, the next Enter creates the task
  }
  private accept(i: number) {
    const o = this.opts[i]; const v = this.input.value; const cur = this.input.selectionStart ?? v.length;
    const t = tokenAt(v, cur); if (!o || !t) return;
    const r = applyCompletion(v, t, o.insert);
    this.input.value = r.text; this.input.setSelectionRange(r.cursor, r.cursor);
    this.refresh();
  }
  private refresh() {
    const v = this.input.value; const s = this.plugin.settings;
    this.opts = suggestionsAt(this.app, s, v, this.input.selectionStart ?? v.length);
    if (this.sel >= this.opts.length || this.sel < 0) this.sel = this.opts.length ? 0 : -1;
    this.drawList();
    this.preview.empty();
    const q = parseQuick(v); let r: Resolved;
    try { r = resolveQuick(this.app, s, q); }
    catch (e) { // a lookup failed: still show the task as typed, and say why the links could not be resolved
      console.warn("Samaya: quick add preview failed", e);
      r = { title: q.title, fm: { estimate: q.estimate ?? s.defaultEstimate }, errors: [`Could not look up the links (${e instanceof Error ? e.message : String(e)})`], ticket: null, project: null, meeting: null, pills: [] };
    }
    try { renderTaskPreview(this.plugin, this.preview, r); } catch (e) { console.warn("Samaya: quick add card failed", e); this.preview.empty(); this.preview.createDiv({ cls: "samaya-quickadd-title", text: r.title }); }
    for (const er of r.errors.filter(e => e !== NO_TITLE)) this.preview.createDiv({ cls: "samaya-quickadd-error", text: er });
  }
  private drawList() {
    this.list.empty();
    this.opts.forEach((o, i) => {
      const row = this.list.createDiv({ cls: "samaya-quickadd-opt" + (i === this.sel ? " is-selected" : "") });
      row.createSpan({ text: o.label }); if (o.hint) row.createSpan({ cls: "samaya-quickadd-hint", text: o.hint });
      row.addEventListener("mousedown", e => { e.preventDefault(); this.accept(i); this.input.focus(); });
    });
  }
  private submit() {
    const r = resolveQuick(this.app, this.plugin.settings, parseQuick(this.input.value));
    if (r.errors.length) { this.input.addClass("is-invalid"); window.setTimeout(() => this.input.removeClass("is-invalid"), 600); return; } // the preview says what is wrong
    this.close();
    safe(createTask(this.app, this.plugin.settings, r.title, r.fm).then(() => { this.plugin.bus.emit(); this.onDone?.(); }), "creating the task");
  }
  onClose() { this.contentEl.empty(); }
}

/** Completion popup for the directive being typed in an input (the inline "+ Add task" boxes). Enter picks a suggestion only while the word is unfinished. */
class QuickSuggest extends AbstractInputSuggest<Option> {
  constructor(private plugin: SamayaPlugin, private el: HTMLInputElement) { super(plugin.app, el); }
  getSuggestions(): Option[] { const v = this.el.value; return suggestionsAt(this.app, this.plugin.settings, v, this.el.selectionStart ?? v.length); }
  renderSuggestion(o: Option, el: HTMLElement) { el.createSpan({ text: o.label }); if (o.hint) el.createSpan({ cls: "samaya-quickadd-hint", text: ` ${o.hint}` }); }
  selectSuggestion(o: Option) {
    const v = this.el.value; const t = tokenAt(v, this.el.selectionStart ?? v.length); if (!t) return;
    const r = applyCompletion(v, t, o.insert);
    this.el.value = r.text; this.el.setSelectionRange(r.cursor, r.cursor); this.el.dispatchEvent(new Event("input")); this.close();
  }
}

/** What was being typed in an inline add field: the views redraw now and then, and the new field takes the text, the focus and the caret over. */
const drafts = new Map<string, { value: string; focused: boolean; start: number; end: number }>();

/**
 * Makes an "+ Add task" input understand the quick-add line. `directives` (e.g. "@week", "#website &PROJ-1") are put in the field up front and
 * come back after every task, so the place the box is in is visible and can be changed by editing it; `base` are the properties that place gives anyway.
 */
export function bindQuickAdd(plugin: SamayaPlugin, input: HTMLInputElement, base: () => Record<string, string | number>, done: () => void, directives = ""): void {
  const pre = directives ? directives + " " : "";
  const key = `${directives}|${input.getAttribute("placeholder") ?? ""}`;
  let focused = false;
  const keep = () => { // remember the field's state (or forget it when there is nothing to keep)
    if (input.value && (focused || input.value.trim() !== directives.trim())) drafts.set(key, { value: input.value, focused, start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length });
    else if (input.value || !focused) drafts.delete(key);
  };
  // the field shows its own placeholder; the directives of the place appear when it is clicked into (and go again when left alone)
  const reset = () => { input.value = document.activeElement === input ? pre : ""; show(); keep(); };
  new QuickSuggest(plugin, input);
  // under the field: a virtual task card showing what Enter will create, and (while the field has the focus) the legend
  const box = document.createElement("div"); box.className = "samaya-quickadd-inline"; input.after(box);
  const show = () => {
    box.replaceChildren(); const v = input.value;
    if (v.trim()) { // (a placeholder title stands in until one is typed)
      try {
        const r = resolveQuick(plugin.app, plugin.settings, parseQuick(v), base());
        renderTaskPreview(plugin, box, r);
        for (const er of r.errors.filter(e => e !== NO_TITLE)) box.createDiv({ cls: "samaya-quickadd-error", text: er });
      } catch (e) { console.warn("Samaya: quick add preview failed", e); box.replaceChildren(); }
    }
    if (focused) { try { renderLegend(box, plugin.settings, "Enter completes a suggestion, Enter again creates the task"); } catch (e) { console.warn("Samaya: quick add legend failed", e); } }
  };
  input.addEventListener("input", () => { show(); keep(); });
  for (const ev of ["keyup", "click"]) input.addEventListener(ev, keep);
  input.addEventListener("focus", () => {
    focused = true;
    if (pre && !input.value) { input.value = pre; input.setSelectionRange(pre.length, pre.length); }
    show(); keep();
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => { // (a field that is being redrawn is gone by now: its draft stays for the new one)
      if (!input.isConnected) return;
      focused = false;
      if (input.value.trim() === directives.trim()) input.value = "";
      show(); keep();
    }, 0);
  });
  const draft = drafts.get(key);
  if (draft) {
    input.value = draft.value; show();
    if (draft.focused) for (const ms of [0, 150]) window.setTimeout(() => { if (input.isConnected && document.activeElement !== input) { input.focus(); input.setSelectionRange(draft.start, draft.end); } }, ms);
  }
  input.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing) return;
    const typed = input.value; if (!typed.trim()) return;
    const q = parseQuick(typed);
    if (q.errors.length === 1 && q.errors[0] === "The task needs a title") return; // only the prefilled directives: nothing to add yet
    const r = resolveQuick(plugin.app, plugin.settings, q, base());
    if (r.errors.length) { new Notice(`Samaya: ${r.errors.join("; ")}`); input.addClass("is-invalid"); window.setTimeout(() => input.removeClass("is-invalid"), 600); return; }
    reset();
    createTask(plugin.app, plugin.settings, r.title, r.fm)
      .then(() => { plugin.bus.emit(); window.setTimeout(done, 250); }) // the metadata cache needs a moment to index the new note
      .catch((err: unknown) => { if (!input.value.trim() || input.value === pre) input.value = typed; /* keep what was typed */ new Notice(`Samaya: could not create the task (${err instanceof Error ? err.message : String(err)})`); });
  });
}
