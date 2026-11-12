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
  const cards = () => Array.from(el.querySelectorAll<HTMLElement>(".samaya-task-card, .samaya-tc-head"));
  const f = plugin.focus.state;
  if (!file || f) { cards().forEach(c => c.remove()); return; }
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
  if (existing.length === hosts.length * (withHead ? 2 : 1) && existing.every(c => c.dataset.key === key && hosts.includes(c.parentElement as HTMLElement))) return;
  existing.forEach(c => c.remove());
  for (const host of hosts) {
    const title = host.querySelector(":scope > .inline-title");
    const card = build();
    host.insertBefore(card, anchorIn(host));
    if (withHead) host.insertBefore(head(), title ?? card); // before the title: floats right, on the title's line
  }

  /** Clock and Focus button, on the title's line. */
  function head(): HTMLElement {
    const h = createDiv({ cls: "samaya-tc-head" }); h.dataset.key = key;
    const act = showToday ? todayAct : t.actual, est = showToday ? todayEst : t.estimate;
    const clock = h.createDiv({ cls: "samaya-tc-clock" + (est && act > est ? " is-over" : ""), attr: { title: showToday ? "Today" : "Total" } });
    clock.createSpan({ cls: "samaya-tc-big", text: fmtHm(act) });
    clock.createSpan({ cls: "samaya-tc-bigsep", text: "/" });
    clock.createSpan({ cls: "samaya-tc-big is-est", text: est ? fmtHm(est) : "--:--" });
    const go = h.createEl("button", { cls: "samaya-tc-focus mod-cta", attr: { "aria-label": "Start focus on this task" } });
    setIcon(go.createSpan({ cls: "samaya-tc-btn-icon" }), "timer"); go.createSpan({ text: "Focus" });
    go.addEventListener("click", () => { void plugin.focus.start(file!); });
    return h;
  }

  function build(): HTMLElement {
    const card = createDiv({ cls: "samaya-task-card" }); card.dataset.key = key;
    const done = t.status === "done";

    const rows = card.createDiv("samaya-tc-rows");
    const row = (label: string, icon: string) => {
      const r = rows.createDiv("samaya-tc-row");
      const l = r.createDiv("samaya-tc-key"); setIcon(l.createSpan({ cls: "samaya-tc-key-icon" }), icon); l.createSpan({ text: label });
      return r.createDiv("samaya-tc-value");
    };

    // status: a button, tick the task off (or reopen it) right here
    const sv = row("Status", "circle-dot");
    const sb = sv.createEl("button", { cls: "samaya-tc-pill samaya-tc-status" + (done ? " is-done" : ""), attr: { "aria-label": done ? "Mark as to do" : "Mark as done" } });
    setIcon(sb.createSpan({ cls: "samaya-tc-pill-icon" }), done ? "circle-check" : "circle"); sb.createSpan({ text: done ? "Done" : "To do" });
    sb.addEventListener("click", () => {
      void patchTask(plugin.app, file!, done ? { status: "todo", completed: null } : { status: "done", completed: today() });
    });

    // time: tracked of estimated, the whole task and (when that differs) today's piece
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
