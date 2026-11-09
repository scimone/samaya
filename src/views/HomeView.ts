import { BasesView, QueryController, TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { calendarEnabled, calendarEvents } from "../calendar";
import type { IcsEvent } from "../ics";
import { Task, allTasks, createTask, rootOf, setDone, sortTasks } from "../model";
import { greeting, inMinutes, pickMoment, weekIntent } from "../home";
import { addDays, fmtDur, fmtHm, hmToMin, minToHm, parseTitleEstimate, parseYmd, startOfWeek, today } from "../util";
import { nowMin } from "../workday";
import { weekSummary, workedMinutes } from "../worktime";

export const HOME_VIEW_TYPE = "samaya-home";
const MAX_TODAY = 7;

/** The Home page: one calm screen that shows where you are in the day and the week, and the next sensible step. */
export class HomeView extends BasesView {
  readonly type = HOME_VIEW_TYPE;
  private root: HTMLElement;
  private timer = 0;
  private token = 0;
  private off: Array<() => void> = [];

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    this.root = parentEl.createDiv("samaya-home");
    const ref = this.app.metadataCache.on("changed", () => this.schedule());
    this.off.push(() => this.app.metadataCache.offref(ref), this.plugin.bus.on(() => this.schedule()));
    const tick = window.setInterval(() => this.schedule(), 30000);
    this.off.push(() => window.clearInterval(tick));
    void this.render();
  }
  onunload() { window.clearTimeout(this.timer); this.off.forEach(f => f()); this.off = []; }
  onDataUpdated(): void { /* the page reads the vault itself */ }

  private schedule() {
    if (!this.root.isConnected) return;
    // do not repaint while the user is typing in the add-task box
    if (this.root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.value) return;
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render(); }, 150);
  }

  private async nextEvent(): Promise<IcsEvent | null> {
    const s = this.plugin.settings; if (!calendarEnabled(s)) return null;
    const d0 = parseYmd(today());
    try {
      const evs = await calendarEvents(this.plugin, d0, new Date(d0.getTime() + 86400000));
      return evs.find(e => !e.allDay && e.end.getTime() > Date.now()) ?? null;
    } catch { return null; }
  }

  private async render() {
    const token = ++this.token;
    const ev = await this.nextEvent();
    if (token !== this.token || !this.root.isConnected) return;

    const p = this.plugin; const s = p.settings; const td = today();
    const all = allTasks(this.app, s);
    const day = sortTasks(all.filter(t => t.planned === td));
    const open = day.filter(t => t.status !== "done");
    const overdue = all.filter(t => t.planned && t.planned < td && t.status !== "done");
    const l = p.workday.log;
    const moment = pickMoment({
      started: p.workday.started || !!l?.end, ended: !!l?.end, onBreak: p.workday.onBreak,
      now: nowMin(), shutdown: p.workWindowFor(today())[1], open: open.length, total: day.length,
    });

    const keepInput = this.root.querySelector<HTMLInputElement>(".samaya-home-add")?.value ?? "";
    this.root.empty();
    this.header(this.root);
    this.hero(this.root, moment, open, day, ev);
    this.todayList(this.root, day, overdue.length);
    this.week(this.root, all);
    this.links(this.root, all);
    if (keepInput) { const i = this.root.querySelector<HTMLInputElement>(".samaya-home-add"); if (i) i.value = keepInput; }
  }

  // ---------------------------------------------------------------- header
  private header(c: HTMLElement) {
    const h = c.createDiv("samaya-home-head");
    h.createEl("h1", { text: greeting(new Date().getHours()) });
    h.createDiv({ cls: "samaya-home-date", text: new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) });
  }

  // ---------------------------------------------------------------- hero: the next sensible step
  private hero(c: HTMLElement, moment: ReturnType<typeof pickMoment>, open: Task[], day: Task[], ev: IcsEvent | null) {
    const p = this.plugin; const wd = p.workday; const l = wd.log;
    const card = c.createDiv(`samaya-home-hero is-${moment}`);
    const kicker = card.createDiv("samaya-home-kicker");
    kicker.createSpan("samaya-home-dot");
    const label = kicker.createSpan();
    const title = card.createDiv("samaya-home-title"); const sub = card.createDiv("samaya-home-sub");
    const row = card.createDiv("samaya-home-actions");
    const cta = (text: string, fn: () => void) => { row.createEl("button", { text, cls: "mod-cta" }).onclick = fn; };
    const quiet = (text: string, fn: () => void) => { row.createEl("button", { text, cls: "samaya-link-btn" }).onclick = fn; };
    const planned = day.reduce((a, t) => a + (t.estimate || p.settings.defaultEstimate), 0);
    const meeting = ev ? `${hmToMinText(ev.start)} ${ev.title}` : "";
    const meetingIn = ev ? inMinutes(Math.round((ev.start.getTime() - Date.now()) / 60000)) : "";

    if (moment === "morning") {
      label.setText("Day not started");
      title.setText(day.length ? `${day.length} task${day.length > 1 ? "s" : ""} planned for today` : "Nothing planned yet");
      sub.setText(day.length ? `${fmtDur(planned)} planned${ev ? ` · first up ${meeting}` : ""}` : "Take two minutes to choose what matters today.");
      cta("Plan my day", () => p.startGuide()); quiet("Just start", () => { void wd.startDay(); });
    } else if (moment === "working") {
      const worked = wd.worked();
      label.setText(`Working · ${fmtDur(worked)}`);
      const focus = p.focus.file; const next = focus ? null : this.nextTask(open);
      if (focus) { title.setText(`Focus: ${focus.basename}`); sub.setText(p.focus.state?.startedAt ? "Timer is running." : "Timer is paused."); cta("Open focus", () => { void p.focus.openView(); }); }
      else if (next) {
        title.setText(next.title);
        sub.setText([`${open.length} open today`, ev ? `${meeting} ${meetingIn}` : ""].filter(Boolean).join(" · "));
        cta("Start focus", () => { void p.focus.start(next.file); });
      } else { title.setText("Nothing left on today's list"); sub.setText(ev ? `Next: ${meeting} ${meetingIn}` : "Add a task below, or call it a day."); }
      quiet("Plan my day", () => p.startGuide()); quiet("Break", () => { void wd.startBreak(); }); quiet("Shut down", () => p.startShutdown());
    } else if (moment === "break") {
      label.setText("On break");
      title.setText(l?.open ? fmtDur(Math.max(0, nowMin() - hmToMin(l.open.start))) : "On break");
      sub.setText(l?.open ? `since ${l.open.start}` : "");
      cta("Back to work", () => { void wd.endBreak(); }); quiet("Plan my day", () => p.startGuide());
    } else if (moment === "wrapup") {
      label.setText(`Working · ${fmtDur(wd.worked())}`);
      const allDone = day.length > 0 && open.length === 0;
      title.setText(allDone ? "Everything is done" : "Time to wrap up");
      sub.setText(allDone ? `${day.length} of ${day.length} tasks finished.` : `${open.length} task${open.length === 1 ? "" : "s"} still open - move them on, or finish them.`);
      cta("Shut down", () => p.startShutdown()); quiet("Plan my day", () => p.startGuide()); quiet("Break", () => { void wd.startBreak(); });
    } else {
      const worked = l ? workedMinutes(l, 1440) : 0;
      label.setText("Day finished");
      title.setText(fmtDur(worked));
      sub.setText(l ? `${l.start} – ${l.end} · ${day.filter(t => t.status === "done").length} of ${day.length} tasks done` : "");
      quiet("Reopen day", () => { void wd.reopenDay(); }); quiet("Work time", () => { void p.openDashboard(); });
    }
  }

  /** The task to do next: the scheduled one whose slot is current or coming up, else the first open one. */
  private nextTask(open: Task[]): Task | null {
    const n = nowMin(); const est = (t: Task) => t.estimate || this.plugin.settings.defaultEstimate;
    const timed = open.filter(t => t.start).sort((a, b) => hmToMin(a.start) - hmToMin(b.start));
    return timed.find(t => hmToMin(t.start) + est(t) > n) ?? open.find(t => !t.start) ?? timed[0] ?? null;
  }

  // ---------------------------------------------------------------- today
  private todayList(c: HTMLElement, day: Task[], overdue: number) {
    const p = this.plugin; const s = p.settings;
    const sec = c.createDiv("samaya-home-sec");
    const head = sec.createDiv("samaya-home-sec-head");
    head.createSpan({ cls: "samaya-home-sec-title", text: "Today" });
    const done = day.filter(t => t.status === "done").length;
    head.createSpan({ cls: "samaya-home-sec-meta", text: day.length ? `${done} of ${day.length} done` : "" });
    if (day.length) {
      const bar = sec.createDiv("samaya-donebar-track samaya-home-bar"); const fill = bar.createDiv("samaya-donebar-fill");
      fill.style.width = `${(done / day.length) * 100}%`; fill.toggleClass("is-complete", done === day.length);
    }
    // open tasks first (by time), finished ones after, capped
    const shown = [...day.filter(t => t.status !== "done"), ...day.filter(t => t.status === "done")].slice(0, MAX_TODAY);
    const list = sec.createDiv("samaya-home-list");
    shown.forEach(t => {
      const r = list.createDiv("samaya-home-task" + (t.status === "done" ? " is-done" : ""));
      const cb = r.createEl("input", { type: "checkbox", cls: "samaya-check" }); cb.checked = t.status === "done";
      cb.addEventListener("change", () => { void setDone(this.app, t, cb.checked); });
      const name = r.createSpan({ cls: "samaya-home-task-title", text: t.title });
      name.addEventListener("click", e => { void this.app.workspace.getLeaf(e.ctrlKey || e.metaKey ? "tab" : false).openFile(t.file); });
      r.createSpan({ cls: "samaya-home-task-time", text: t.start || (t.estimate ? fmtHm(t.estimate) : "") });
    });
    if (day.length > shown.length) sec.createEl("button", { cls: "samaya-link-btn", text: `+ ${day.length - shown.length} more in the planner` }).onclick = () => { void p.openPlanner(); };
    const add = sec.createEl("input", { type: "text", cls: "samaya-add samaya-home-add", attr: { placeholder: "+ Add a task for today (append 30m or 1h for an estimate)" } });
    add.addEventListener("keydown", e => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      const t = parseTitleEstimate(add.value); add.value = "";
      void createTask(this.app, s, t.title, { planned: today(), estimate: t.estimate ?? s.defaultEstimate });
    });
    if (overdue) {
      const n = sec.createDiv("samaya-home-nudge");
      n.createSpan({ text: `${overdue} unfinished task${overdue > 1 ? "s" : ""} from earlier days. ` });
      n.createEl("button", { cls: "samaya-link-btn", text: "Sort them out" }).onclick = () => p.startGuide();
    }
  }

  // ---------------------------------------------------------------- week
  private week(c: HTMLElement, all: Task[]) {
    const p = this.plugin; const s = p.settings; const td = today(); const wk = startOfWeek(td);
    const sec = c.createDiv("samaya-home-sec");
    const head = sec.createDiv("samaya-home-sec-head");
    head.createSpan({ cls: "samaya-home-sec-title", text: "This week" });
    const fmt = (d: string) => parseYmd(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    head.createSpan({ cls: "samaya-home-sec-meta", text: `${fmt(wk)} – ${fmt(addDays(wk, 6))}` });

    const strip = sec.createDiv("samaya-home-week");
    const days = Math.max(5, Math.min(7, s.workDays));
    let weekTotal = 0, weekDone = 0;
    for (let i = 0; i < days; i++) {
      const d = addDays(wk, i); const ts = all.filter(t => t.planned === d); const done = ts.filter(t => t.status === "done").length;
      weekTotal += ts.length; weekDone += done;
      const cell = strip.createDiv("samaya-home-day" + (d === td ? " is-today" : d < td ? " is-past" : ""));
      cell.createDiv({ cls: "samaya-home-day-dow", text: parseYmd(d).toLocaleDateString(undefined, { weekday: "short" }) });
      cell.createDiv({ cls: "samaya-home-day-num", text: String(parseYmd(d).getDate()) });
      const bar = cell.createDiv("samaya-home-day-bar"); const fill = bar.createDiv("samaya-home-day-fill");
      fill.style.width = ts.length ? `${(done / ts.length) * 100}%` : "0%";
      cell.createDiv({ cls: "samaya-home-day-count", text: ts.length ? `${done}/${ts.length}` : "–" });
    }
    const unscheduled = all.filter(t => !t.planned && t.week === wk && t.status !== "done").length;
    const worked = weekSummary(p.workday.allLogs(), wk, s.weeklyHours, s.workDays, td, nowMin()).worked;
    sec.createDiv({
      cls: "samaya-home-week-meta",
      text: [`${weekDone} of ${weekTotal} scheduled tasks done`, worked ? `${fmtDur(worked)} worked` : "", unscheduled ? `${unscheduled} weekly task${unscheduled > 1 ? "s" : ""} without a day` : ""].filter(Boolean).join(" · "),
    });

    const intent = weekIntent(new Date().getDay(), new Date().getHours());
    const row = sec.createDiv("samaya-home-actions");
    const btn = (text: string, icon: string, hot: boolean, fn: () => void) => {
      const b = row.createEl("button", { cls: hot ? "mod-cta" : "" }); setIcon(b.createSpan("samaya-home-btn-icon"), icon); b.createSpan({ text }); b.onclick = fn;
    };
    btn("Plan week", "layout-dashboard", intent === "plan", () => { void p.openWeekPlanner(); });
    btn("Review week", "check-circle-2", intent === "review", () => { void p.reviewWeek(); });
  }

  // ---------------------------------------------------------------- links
  private links(c: HTMLElement, all: Task[]) {
    const p = this.plugin; const s = p.settings;
    const row = c.createDiv("samaya-home-links");
    const link = (text: string, fn: () => void) => { row.createEl("button", { cls: "samaya-link-btn", text }).onclick = fn; };
    const backlog = all.filter(t => !t.planned && !t.week && t.status !== "done").length;
    link(backlog ? `Backlog · ${backlog}` : "Backlog", () => {
      const r = rootOf(s.tasksPath); const f = this.app.vault.getAbstractFileByPath(r === "/" ? "Tasks.base" : `${r}/Tasks.base`);
      if (f instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(f); else void p.openPlanner();
    });
    link("Planner", () => { void p.openPlanner(); });
    const cmd = (id: string) => () => { (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(`samaya:${id}`); };
    if (s.jiraOn || s.gitlabOn) link("Tickets", cmd("open-tickets"));
    if (s.projectsOn) link("Projects", cmd("open-projects"));
    if (s.journalOn) link("Journal", cmd("open-journal"));
    link("Work time", () => { void p.openDashboard(); });
  }
}

const hmToMinText = (d: Date): string => minToHm(d.getHours() * 60 + d.getMinutes());
