import { TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { dayTask, patchTask, readTask, readTicket } from "../model";
import { projectPathOf } from "../projects";
import { addDays, fmtHm, minToHm, parseYmd, today } from "../util";
import { trackedBefore } from "./place";

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
export function renderTaskCard(plugin: SamayaPlugin, el: HTMLElement, file: TFile | null) {
  const cards = () => Array.from(el.querySelectorAll<HTMLElement>(".samaya-task-card, .samaya-tc-line"));
  const clear = () => { cards().forEach(c => c.remove()); el.querySelectorAll(".samaya-tc-host").forEach(h => { h.removeClass("samaya-tc-host"); (h as HTMLElement).style.removeProperty("--tc-pl"); (h as HTMLElement).style.removeProperty("--tc-pr"); }); };
  const f = plugin.focus.state;
  if (!file || f) { clear(); return; }
  const t = readTask(plugin.app, file);
  const day = today(); const dt = dayTask(t, day); const hasToday = t.sessions.some(g => g.date === day);
  const todayEst = hasToday ? dt.estimate : 0;
  const todayAct = Math.max(0, t.actual - trackedBefore(plugin, t, day));
  const showToday = hasToday && (todayEst !== t.estimate || todayAct !== t.actual);
  const projectPath = plugin.settings.projectsOn ? projectPathOf(plugin.app, file) : "";
  const withHead = hasToday && t.status !== "done";
  const key = JSON.stringify([withHead, file.path, t.status, t.sessions, t.estimate, t.actual, todayEst, todayAct, showToday, t.ticket, projectPath, day]);

  // where it goes: under the note title (inside the editor / reading column); without such a column, above the note
  const sizers = Array.from(el.querySelectorAll<HTMLElement>(".cm-sizer, .markdown-preview-sizer"));
  const content = el.querySelector(":scope > .view-content");
  if (!sizers.length && !content) return;
  const hosts = sizers.length ? sizers : [content as HTMLElement];
  const existing = cards();
  if (existing.length === hosts.length * 2 && existing.every(c => c.dataset.key === key && hosts.includes(c.parentElement as HTMLElement))) return;
  clear();
  for (const host of hosts) {
    const title = host.querySelector<HTMLElement>(":scope > .inline-title");
    const card = build();
    host.insertBefore(card, anchorIn(host));
    const line = titleLine(); host.insertBefore(line, title ?? card);
    host.addClass("samaya-tc-host");
    if (title) pin(host, title, line); else line.addClass("is-flow");
  }

  /** The checkbox (left) and, for a task planned today, the clock and Focus button (right): one layer on the title's first line. */
  function titleLine(): HTMLElement {
    const h = createDiv({ cls: "samaya-tc-line" }); h.dataset.key = key;
    const done = t.status === "done";
    const box = h.createEl("input", { cls: "samaya-tc-check", type: "checkbox", attr: { "aria-label": done ? "Done - click to reopen" : "Mark as done" } });
    box.checked = done;
    box.addEventListener("change", () => { void patchTask(plugin.app, file!, box.checked ? { status: "done", completed: today() } : { status: "todo", completed: null }); });
    if (!withHead) return h;
    h.createDiv("samaya-tc-spacer");
    const act = showToday ? todayAct : t.actual, est = showToday ? todayEst : t.estimate;
    const clock = h.createDiv({ cls: "samaya-tc-clock" + (est && act > est ? " is-over" : "") });
    const num = (label: string, text: string, cls = "") => {
      const c = clock.createDiv("samaya-tc-num");
      c.createSpan({ cls: "samaya-tc-numlabel", text: label }); c.createSpan({ cls: "samaya-tc-big " + cls, text });
    };
    num("actual", fmtHm(act)); clock.createSpan({ cls: "samaya-tc-bigsep", text: "/" }); num("planned", est ? fmtHm(est) : "--:--", "is-est");
    const go = h.createEl("button", { cls: "samaya-tc-focus mod-cta", attr: { "aria-label": "Start focus on this task" } });
    setIcon(go.createSpan({ cls: "samaya-tc-btn-icon" }), "timer"); go.createSpan({ text: "Focus" });
    go.addEventListener("click", () => { void plugin.focus.start(file!); });
    return h;
  }

  function build(): HTMLElement {
    const card = createDiv({ cls: "samaya-task-card" }); card.dataset.key = key;
    const rows = card.createDiv("samaya-tc-rows");
    const row = (label: string, icon: string) => {
      const r = rows.createDiv("samaya-tc-row");
      const l = r.createDiv("samaya-tc-key"); setIcon(l.createSpan({ cls: "samaya-tc-key-icon" }), icon); l.createSpan({ text: label });
      return r.createDiv("samaya-tc-value");
    };

    // time: tracked of estimated, the whole task
    if (t.estimate || t.actual) {
      const tv = row("Time", "clock");
      const p = tv.createSpan({ cls: "samaya-tc-time" + (t.estimate && t.actual > t.estimate ? " is-over" : "") });
      p.createSpan({ cls: "samaya-tc-act", text: fmtHm(t.actual) });
      p.createSpan({ cls: "samaya-tc-est", text: ` of ${t.estimate ? fmtHm(t.estimate) : "--:--"}` });
    }

    // planned pieces
    if (t.sessions.length) {
      const pv = row("Planned", "calendar");
      for (const g of t.sessions) {
        const chip = pv.createSpan({ cls: "samaya-tc-pill samaya-tc-session" + (g.date === day ? " is-today" : g.date < day ? " is-past" : "") });
        chip.createSpan({ cls: "samaya-tc-day", text: dayLabel(g.date) });
        const when = g.s !== null ? `${minToHm(g.s)}–${minToHm(g.s + g.dur)}` : g.dur ? fmtHm(g.dur) : "";
        if (when) chip.createSpan({ cls: "samaya-tc-when", text: when });
      }
    } else {
      row("Planned", "calendar").createSpan({ cls: "samaya-tc-none", text: "Not planned yet" });
    }

    // where it belongs
    const link = (parent: HTMLElement, path: string, label?: (f: TFile) => string) => {
      const target = plugin.app.vault.getAbstractFileByPath(path);
      if (!(target instanceof TFile)) return;
      const a = parent.createEl("a", { cls: "samaya-tc-link", text: label ? label(target) : target.basename });
      a.addEventListener("click", e => { e.preventDefault(); void plugin.openNoteInMain(target); });
    };
    if (projectPath) link(row("Project", "folder-kanban"), projectPath);
    if (t.ticket) { const tp = plugin.app.metadataCache.getFirstLinkpathDest(t.ticket, file!.path)?.path; if (tp) link(row("Ticket", "ticket"), tp, f => { const k = readTicket(plugin.app, f); return k.summary ? `${k.key} • ${k.summary}` : k.key; }); }
    return card;
  }
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
