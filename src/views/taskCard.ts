import { Menu, TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { dayTask, patchTask, readTask, readTicket } from "../model";
import { projectPathOf } from "../projects";
import { HORIZONS, addDays, bucketOf, fmtHm, parseDuration, minToHm, parseYmd, startOfWeek, today } from "../util";
import { focusButton, roundCheck, trackedBefore } from "./place";
import { addPlanItems, addProjectItems, addTicketItems } from "./common";

const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
/** "Thu, 12 Nov" (Today / Tomorrow for those). */
function dayLabel(date: string): string {
  const t = today();
  if (date === t) return "Today";
  if (date === addDays(t, 1)) return "Tomorrow";
  return DAY_FMT.format(parseYmd(date));
}

/**
 * The properties of a task note, as a quiet block under the note's title (in the readable column, like Obsidian's own properties):
 * one row per property - Status (click to tick off), Time, Planned, Project, Ticket. A task planned for today also gets its clock
 * (tracked / planned, today's piece when that differs from the whole task) and a Focus button, on the same line as the title.
 * While a focus is running (or on a break) the block is gone altogether: the focus bar on top takes over.
 */
export function renderTaskCard(plugin: SamayaPlugin, el: HTMLElement, file: TFile | null, inSide = false) {
  const cards = () => Array.from(el.querySelectorAll<HTMLElement>(".samaya-task-card, .samaya-tc-line")).filter(c => !c.closest(".samaya-side-bar")); // not the line in the side pane's top bar
  const clear = () => { cards().forEach(c => c.remove()); el.querySelectorAll(".samaya-tc-host").forEach(h => { h.removeClass("samaya-tc-host"); (h as HTMLElement).style.removeProperty("--tc-pl"); (h as HTMLElement).style.removeProperty("--tc-pr"); }); };
  const f = plugin.focus.state;
  if (!file) { clear(); return; }
  const mine = !!f && f.path === file.path;
  const t = readTask(plugin.app, file);
  const day = today(); const dt = dayTask(t, day); const hasToday = t.sessions.some(g => g.date === day);
  const todayEst = hasToday ? dt.estimate : 0;
  const todayAct = Math.max(0, t.actual - trackedBefore(plugin, t, day));
  const showToday = hasToday && (todayEst !== t.estimate || todayAct !== t.actual);
  const projectPath = plugin.settings.projectsOn ? projectPathOf(plugin.app, file) : "";
  const withHead = (hasToday || mine) && t.status !== "done";
  const key = JSON.stringify([inSide, withHead, f ? [f.path, !!f.startedAt] : null, file.path, t.status, t.sessions, t.estimate, t.actual, todayEst, todayAct, showToday, t.ticket, projectPath, day]);

  // where it goes: under the note title (inside the editor / reading column); without such a column, above the note
  const sizers = Array.from(el.querySelectorAll<HTMLElement>(".cm-sizer, .markdown-preview-sizer"));
  const content = el.querySelector(":scope > .view-content");
  if (!sizers.length && !content) return;
  const hosts = sizers.length ? sizers : [content as HTMLElement];
  const existing = cards();
  if (existing.length === hosts.length * ((f ? 0 : 1) + (inSide ? 0 : 1)) && existing.every(c => c.dataset.key === key && hosts.includes(c.parentElement as HTMLElement))) return;
  clear();
  for (const host of hosts) {
    const title = host.querySelector<HTMLElement>(":scope > .inline-title");
    const card = f ? null : build(); // while a focus runs the properties are gone; checkbox, clock and the Pause button stay
    if (card) host.insertBefore(card, anchorIn(host));
    if (inSide) continue; // the title line (checkbox, clock, Focus) is in the side pane's top bar
    const line = taskLine(plugin, file); line.dataset.key = key; host.insertBefore(line, title ?? card ?? anchorIn(host));
    host.addClass("samaya-tc-host");
    if (title) pin(host, title, line); else line.addClass("is-flow");
  }

  /** Where a task without a day waits. */
  function waitingLabel(): string {
    if (t.week) return t.week === startOfWeek(day) ? "This week" : `Week of ${dayLabel(t.week)}`;
    const h = bucketOf(t.horizon, t.later, day);
    return `Backlog: ${(HORIZONS.find(([k]) => k === h)?.[1] ?? "Someday").toLowerCase()}`;
  }

  function build(): HTMLElement {
    const card = createDiv({ cls: "samaya-task-card" }); card.dataset.key = key;
    const rows = card.createDiv("samaya-tc-rows");
    const row = (label: string, icon: string) => {
      const r = rows.createDiv("samaya-tc-row");
      const l = r.createDiv("samaya-tc-key"); setIcon(l.createSpan({ cls: "samaya-tc-key-icon" }), icon); l.createSpan({ text: label });
      return r.createDiv("samaya-tc-value");
    };

    const editable = (v: HTMLElement, label: string, menu: (m: Menu) => void) => {
      v.addClass("is-edit"); v.setAttr("role", "button"); v.setAttr("tabindex", "0"); v.setAttr("aria-label", label);
      const open = (e: MouseEvent | KeyboardEvent) => { const m = new Menu(); menu(m); if (e instanceof MouseEvent) m.showAtMouseEvent(e); else { const r = v.getBoundingClientRect(); m.showAtPosition({ x: r.left, y: r.bottom }); } };
      v.addEventListener("click", open);
      v.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } });
    };

    // planned: the pieces, or where the task waits (this week / backlog); click to change
    const pv = row("Planned", "calendar");
    editable(pv, "Change the plan", m => addPlanItems(m, plugin, t));
    for (const g of t.sessions) {
      const chip = pv.createSpan({ cls: "samaya-tc-pill samaya-tc-session" + (g.date === day ? " is-today" : g.date < day ? " is-past" : "") });
      chip.createSpan({ cls: "samaya-tc-day", text: dayLabel(g.date) });
      const when = g.s !== null ? `${minToHm(g.s)}–${minToHm(g.s + g.dur)}` : g.dur ? fmtHm(g.dur) : "";
      if (when) chip.createSpan({ cls: "samaya-tc-when", text: when });
    }
    if (t.status !== "done" && (!t.sessions.length || t.rest > 0)) {
      const chip = pv.createSpan({ cls: "samaya-tc-pill samaya-tc-session is-backlog" });
      if (t.sessions.length) chip.createSpan({ cls: "samaya-tc-when", text: `${fmtHm(t.rest)} still` });
      chip.createSpan({ cls: "samaya-tc-day", text: waitingLabel() });
    } else if (!t.sessions.length) pv.createSpan({ cls: "samaya-tc-none", text: "Not planned" });

    // time: tracked of estimated, the whole task; click to change the estimate
    const tv = row("Time", "clock");
    const paintTime = () => {
      tv.empty();
      const p = tv.createSpan({ cls: "samaya-tc-time" + (t.estimate && t.actual > t.estimate ? " is-over" : "") });
      p.createSpan({ cls: "samaya-tc-act", text: fmtHm(t.actual) });
      p.createSpan({ cls: "samaya-tc-est", text: ` of ${t.estimate ? fmtHm(t.estimate) : "--:--"}` });
    };
    paintTime();
    tv.addClass("is-edit"); tv.setAttr("role", "button"); tv.setAttr("tabindex", "0"); tv.setAttr("aria-label", "Change the estimate");
    const editTime = () => {
      if (tv.querySelector("input")) return;
      tv.empty(); tv.createSpan({ cls: "samaya-tc-est", text: "Estimate" });
      const input = tv.createEl("input", { cls: "samaya-tc-input", type: "text", attr: { placeholder: "1:30, 90m, 1.5h" } });
      input.value = t.estimate ? fmtHm(t.estimate) : ""; input.focus(); input.select();
      let ended = false;
      const end = (save: boolean) => {
        if (ended) return; ended = true;
        const raw = input.value.trim(); const v = parseDuration(raw);
        if (save && (raw === "" || (v !== null && v > 0)) && (v ?? 0) !== t.estimate) void patchTask(plugin.app, file!, { estimate: raw === "" ? null : v });
        else paintTime();
      };
      input.addEventListener("keydown", e => { if (e.key === "Enter") end(true); else if (e.key === "Escape") end(false); e.stopPropagation(); });
      input.addEventListener("blur", () => end(true));
    };
    tv.addEventListener("click", editTime);
    tv.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target === tv) { e.preventDefault(); editTime(); } });

    // where it belongs: click to open, change or remove
    const target = (path: string) => { const x = plugin.app.vault.getAbstractFileByPath(path); return x instanceof TFile ? x : null; };
    const relation = (label: string, icon: string, path: string, text: (f: TFile) => string, items: (m: Menu) => void) => {
      const v = row(label, icon); const f = path ? target(path) : null;
      editable(v, f ? `${label}: change or open` : `Assign ${label.toLowerCase()}`, m => {
        if (f) m.addItem(i => i.setTitle("Open note").setIcon("file").onClick(() => { void plugin.openNoteInMain(f); }));
        items(m);
      });
      if (f) v.createSpan({ cls: "samaya-tc-link", text: text(f) }); else v.createSpan({ cls: "samaya-tc-none", text: "None" });
    };
    const ticketPath = t.ticket ? plugin.app.metadataCache.getFirstLinkpathDest(t.ticket, file!.path)?.path ?? "" : "";
    if (plugin.settings.projectsOn || projectPath) relation("Project", "folder-kanban", projectPath, f => f.basename, m => addProjectItems(m, plugin, t));
    if (plugin.settings.jiraOn || plugin.settings.gitlabOn || ticketPath) relation("Ticket", "ticket", ticketPath, f => { const k = readTicket(plugin.app, f); return k.summary ? `${k.key} • ${k.summary}` : k.key; }, m => addTicketItems(m, plugin, t));
    return card;
  }
}

/**
 * The checkbox and, for a task planned today (or in focus), the clock and Focus button, as one line. On the title's first line in a note;
 * in the side pane's top bar (`title` given) the task's title sits between the checkbox and the clock.
 */
export function taskLine(plugin: SamayaPlugin, file: TFile, title?: string): HTMLElement {
  const f = plugin.focus.state; const mine = !!f && f.path === file.path;
  const t = readTask(plugin.app, file);
  const day = today(); const dt = dayTask(t, day); const hasToday = t.sessions.some(g => g.date === day);
  const todayEst = hasToday ? dt.estimate : 0;
  const todayAct = Math.max(0, t.actual - trackedBefore(plugin, t, day));
  const showToday = hasToday && (todayEst !== t.estimate || todayAct !== t.actual);
  const withHead = (hasToday || mine) && t.status !== "done";
  const h = createDiv({ cls: "samaya-tc-line" });
  h.dataset.key = JSON.stringify([title ?? null, withHead, f ? [f.path, !!f.startedAt] : null, file.path, t.status, t.estimate, t.actual, todayEst, todayAct, showToday, plugin.workday.started]);
  const done = t.status === "done";
  roundCheck(h, done, done ? "Done - click to reopen" : "Mark as done", v => { void patchTask(plugin.app, file, v ? { status: "done", completed: today() } : { status: "todo", completed: null }); }, "samaya-tc-check");
  if (title !== undefined) h.createDiv({ cls: "samaya-side-title", text: title, attr: { "aria-label": file.path } });
  if (!withHead) return h;
  if (title === undefined) h.createDiv("samaya-tc-spacer");
  const right = h.createDiv("samaya-tc-right"); // clock and button, bottoms aligned
  const act = showToday ? todayAct : t.actual, est = showToday ? todayEst : t.estimate;
  const clock = right.createDiv({ cls: "samaya-tc-clock" + (est && act > est ? " is-over" : "") });
  const num = (label: string, text: string, cls = "", live = false) => {
    const c = clock.createDiv("samaya-tc-num");
    c.createSpan({ cls: "samaya-tc-numlabel", text: label });
    const n = c.createSpan({ cls: "samaya-tc-big " + cls, text });
    if (live) { n.addClass("samaya-tc-act"); n.dataset.tcBase = String(act); } // counts along while this task is in focus
  };
  num("actual", fmtHm(act + (mine ? plugin.focus.liveMin(file.path) : 0)), "", mine); clock.createSpan({ cls: "samaya-tc-bigsep", text: "/" }); num("planned", est ? fmtHm(est) : "--:--", "is-est");
  if (f || hasToday) { const b = focusButton(plugin, right, t, "samaya-tc-focus"); if (b) b.addClass("mod-cta"); } // Focus, or Pause / Resume (+ Stop) while this task is in focus
  return h;
}

/** Under the inline title if there is one, else before the note's own content. */
function anchorIn(host: HTMLElement): Node | null {
  const title = host.querySelector(":scope > .inline-title");
  if (title) return title.nextSibling;
  return host.querySelector(":scope > .metadata-container, :scope > .cm-contentContainer, :scope > .markdown-preview-view") ?? host.firstChild;
}

/**
 * Lay `line` over the first line of the note's title: same top, left and right, as high as one line of the title.
 * The title gets padding so its text stays clear of the checkbox on the left and the clock and button on the right.
 */
function pin(host: HTMLElement, title: HTMLElement, line: HTMLElement) {
  const place = () => {
    if (!line.isConnected) { ro.disconnect(); return; }
    const hr = host.getBoundingClientRect(), tr = title.getBoundingClientRect(), cs = getComputedStyle(title);
    const fs = parseFloat(cs.fontSize) || 28; const lh = parseFloat(cs.lineHeight) || fs * 1.2;
    const pt = parseFloat(cs.paddingTop) || 0;
    const box = line.querySelector<HTMLElement>(".samaya-tc-check"), right = Array.from(line.children).filter(c => c !== box && !c.hasClass("samaya-tc-spacer"));
    const left = box ? box.offsetWidth + 10 : 0;
    const rw = right.reduce((a, c) => a + (c as HTMLElement).offsetWidth, 0) + Math.max(0, right.length - 1) * 16 + (right.length ? 16 : 0);
    line.style.top = `${tr.top - hr.top + pt}px`; line.style.height = `${lh}px`;
    line.style.left = `${tr.left - hr.left}px`; line.style.width = `${tr.width}px`;
    host.style.setProperty("--tc-pl", `${left}px`); host.style.setProperty("--tc-pr", `${rw}px`);
  };
  const ro = new ResizeObserver(place); ro.observe(title); ro.observe(host);
  requestAnimationFrame(place);
}
