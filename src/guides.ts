import { isDoneState } from "./kanban";
import { reviewItems } from "./views/dayReview";
import { reviewSummary } from "./dayreview";
import { Notice, TFile } from "obsidian";
import { allTickets } from "./model";
import type {} from "./journal";
import { openPeriodNote, periodNotePath } from "./journal";
import { allTasks, sortTasks, isOverdue, onDay } from "./model";
import { ConfirmOverwriteModal } from "./modals";
import { DayPlan, LEGACY_WEEK_HEADINGS, readSection, WEEK_MEETINGS, WEEK_ORDER, WEEK_OVERVIEW, WEEK_TASKS, removeSection, upsertSection, weekMeetings, weekOverview, journalPath, journalWants, meetingLines, readJournalSection, sortByStart, taskLines, toJournalTasks, writeSection } from "./journal";
import { calendarEnabled, calendarEvents, eventNote } from "./calendar";
import { dayPieces } from "./sessions";
import { addDays, hmToMin, parseYmd, today } from "./util";
import { nowMin } from "./workday";
import { isLeftover, weekSteps, weekToPlan } from "./weekplan";
import { capacityOf, weekBuckets } from "./views/weekColumn";
import { workedOn } from "./worktime";
import type SamayaPlugin from "./main";

/** The guided flows: Plan my day, Plan my week, End my day (the steppers are drawn by views/guide.ts). The plugin keeps `guide` (the state) and forwards its guide methods here. */
export class GuideController {
  constructor(private p: SamayaPlugin) {}
  /** Interactive planning: opens the daily planner and walks through it (see views/guide.ts). */
  private leftCollapsedByGuide = false;
  /** Leaves the guide and brings the left sidebar back if the guide hid it. */
  /** The X of a guide: Plan my week goes back to the week view (of the week being planned), the day guides just close. */
  cancelGuide() {
    const g = this.p.guide; const wk = g?.kind === "week" ? g.week ?? "" : null;
    const left = this.closeGuide(wk !== null);
    if (wk !== null) { this.p.weekToShow = wk; this.p.expandTimeline(left); }
  }
  /** `keepLeft`: the left sidebar stays folded (the week view follows); returns whether the guide had hidden it. */
  closeGuide(keepLeft = false): boolean {
    this.p.guide = null; const hid = this.leftCollapsedByGuide;
    if (hid) { this.leftCollapsedByGuide = false; if (!keepLeft) this.p.app.workspace.leftSplit?.expand(); }
    this.p.modeBus.emit();
    this.p.bus.emit();
    return hid;
  }
  /** Interactive week plan: Review, Tickets, Backlog, Schedule, Check (see views/guide.ts and WeeklyBoardView). The left sidebar makes room; This week is the last column. */
  async startWeekGuide() {
    if (this.p.focus.state) { new Notice("Samaya: stop or finish the running focus before planning the week."); return; }
    if (this.p.collapseTimeline(true)) this.leftCollapsedByGuide = true;
    const ws = this.p.app.workspace; const now = new Date(); const wk = weekToPlan(today(), now.getDay());
    const leftover = allTasks(this.p.app, this.p.settings).some(t => isLeftover(t, today(), wk));
    const tickets = this.p.settings.ticketsOn && allTickets(this.p.app, this.p.settings).some(t => !isDoneState(t.state));
    this.p.guide = { step: weekSteps(leftover, tickets)[0], review: leftover, fresh: true, kind: "week", week: wk, tickets };
    await this.p.openPlanner();
    if (ws.leftSplit && !ws.leftSplit.collapsed) { ws.leftSplit.collapse(); this.leftCollapsedByGuide = true; }
    this.p.modeBus.emit(); this.p.bus.emit();
  }
  async finishWeekGuide() {
    const g = this.p.guide; const wk = g?.week; const days = g?.days ?? 5;
    const left = this.closeGuide(true);
    this.p.weekToShow = wk ?? ""; this.p.expandTimeline(left); // back to the week view (not the day), on the week that was planned
    if (!wk) return;
    let saved: TFile | null = null; this.weekWritten = false;
    try { saved = await this.writeWeekPlan(wk, days); } catch (e) { console.error("Samaya: could not write the weekly note", e); new Notice("Samaya: could not write the weekly note (see the console)."); }
    this.noticeWithNote(`Week of ${parseYmd(wk).toLocaleDateString(undefined, { month: "short", day: "numeric" })} planned${saved && this.weekWritten ? " and saved to your weekly note" : ""}.`, saved, "Open weekly note", true);
  }
  /** The weekly note (created if missing) gets an "Overview", the week's "Meetings" by weekday and its "Planned tasks". False when nothing is written. */
  private weekWritten = false;
  private async writeWeekPlan(wk: string, nDays: number): Promise<TFile | null> {
    const s = this.p.settings; const wantPlan = journalWants(s, "journalWeekPlan"), wantMeet = journalWants(s, "journalWeekMeetings"), wantTasks = journalWants(s, "journalWeekTasks");
    if (!s.journalNotes.weekly.on || !(wantPlan || wantMeet || wantTasks)) return null;
    const file = await openPeriodNote(this.p.app, s, "weekly", wk); if (!file) return null;
    const before = await this.p.app.vault.read(file);
    if ([WEEK_OVERVIEW, WEEK_MEETINGS, WEEK_TASKS].some(h => readSection(before, h as Parameters<typeof readSection>[1]).length) && !(await this.askOverwrite("weekly note"))) return file; // planned before: ask first (declined: nothing written)
    this.weekWritten = true;
    const { weekTasks, noDay } = weekBuckets(allTasks(this.p.app, s), wk);
    const events = calendarEnabled(s) ? await calendarEvents(this.p, parseYmd(wk), parseYmd(addDays(wk, 7))).catch(() => []) : [];
    const dates = Array.from({ length: nDays }, (_, i) => addDays(wk, i));
    const plans: DayPlan[] = [];
    for (const d of dates) { // one after the other: the meeting notes are created on the way
      const t0 = parseYmd(d).getTime(), t1 = parseYmd(addDays(d, 1)).getTime(); const cap = capacityOf(this.p, d, events);
      const weekday = parseYmd(d).toLocaleDateString(undefined, { weekday: "long" });
      const tasks = sortByStart(sortTasks(weekTasks.filter(t => t.planned === d)));
      const dayEvents = events.filter(e => e.end.getTime() > t0 && e.start.getTime() < t1).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
      plans.push({ weekday, label: parseYmd(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }), note: (await journalPath(this.p.app, s, d)).split("/").pop()!.replace(/\.md$/, ""),
        planned: tasks.reduce((a, t) => a + (t.estimate || s.defaultEstimate), 0), meetings: cap.meetings, free: cap.free,
        tasks: (await toJournalTasks(this.p.app, tasks, false, true)).map(t => ({ ...t, day: weekday })),
        events: wantMeet ? dayEvents.map(e => ({ ...e, note: e.allDay ? undefined : eventNote(this.p.app, e)?.basename })) : dayEvents });
    }
    const unscheduled = (await toJournalTasks(this.p.app, noDay)).map(t => ({ ...t, day: "no day" }));
    await this.p.app.vault.process(file, t => {
      let x = t; for (const h of [...LEGACY_WEEK_HEADINGS, ...plans.map(p => p.label)]) x = removeSection(x, h); // sections written by earlier versions
      if (wantPlan) x = upsertSection(x, WEEK_OVERVIEW, weekOverview(plans, noDay.length), WEEK_ORDER);
      if (wantMeet) x = upsertSection(x, WEEK_MEETINGS, weekMeetings(plans), WEEK_ORDER);
      if (wantTasks) x = upsertSection(x, WEEK_TASKS, taskLines([...unscheduled, ...plans.flatMap(p => p.tasks)]), WEEK_ORDER);
      return x;
    });
    return file;
  }



  /** A notice with a button that opens the note the planning just wrote. */
  private noticeWithNote(msg: string, file: TFile | null, label: string, autoOpen = false) {
    if (!file) { new Notice(msg); return; }
    if (autoOpen && this.p.settings.journalOpenAfterPlan) { new Notice(msg); void this.p.openNoteInMain(file); return; }
    const frag = document.createDocumentFragment(); frag.createDiv({ text: msg });
    const n = new Notice(frag, 12000);
    frag.createEl("button", { text: label, cls: "mod-cta" }).onclick = () => { n.hide(); void this.p.openNoteInMain(file); };
  }
  async startGuide() {
    if (this.p.focus.state) { new Notice("Samaya: stop or finish the running focus first."); return; }
    this.p.collapseTimeline();
    const ls = this.p.app.workspace.leftSplit;
    if (ls && !ls.collapsed) { ls.collapse(); this.leftCollapsedByGuide = true; } // room for the planner while planning
    const overdue = allTasks(this.p.app, this.p.settings).some(isOverdue);
    this.p.guide = { step: overdue ? 0 : 1, review: overdue, fresh: true, kind: "plan" };
    await this.p.openPlanner(); this.p.bus.emit();
  }
  /** Ask whether a plan that is already written in a note may be replaced. Closing the dialog says no. */
  private askOverwrite(noteLabel: string): Promise<boolean> {
    return new Promise(res => { new ConfirmOverwriteModal(this.p, noteLabel, res).open(); });
  }
  async finishGuide() {
    const g = this.p.guide; if (!g) return; const s = this.p.settings; const td = today();
    const day = sortTasks(onDay(allTasks(this.p.app, s), td));
    const planned = journalWants(s, "journalPlanned") && (await readJournalSection(this.p.app, s, td, "Planned tasks")).length > 0;
    const write = !planned || (await this.askOverwrite("daily note")); // planned before: ask first
    if (write && s.journalOn && calendarEnabled(s)) {
      const from = parseYmd(td); const evs = await calendarEvents(this.p, from, parseYmd(addDays(td, 1))).catch(() => null);
      if (evs) await writeSection(this.p.app, s, td, "Meetings", meetingLines(evs.map(e => ({ ...e, note: e.allDay ? undefined : eventNote(this.p.app, e)?.basename }))));
    }
    if (write && journalWants(s, "journalPlanned")) await writeSection(this.p.app, s, td, "Planned tasks", taskLines(await toJournalTasks(this.p.app, sortByStart(day), false, true)));
    const plans = (this.p.data.dayPlans ??= {}); // the first plan of the day stays as the baseline; planning again does not replace it
    if (!plans[td]) {
      plans[td] = day.map(t => ({ path: t.file.path, est: t.estimate, slots: dayPieces(t.sessions, td).filter(g => g.s !== null).map((g): [number, number] => [g.s!, g.dur]) }));
      for (const d of Object.keys(plans)) if (d < addDays(td, -60)) delete plans[d];
      await this.p.saveData(this.p.data);
    }
    const wasStarted = this.p.workday.started;
    await this.p.workday.startDay();
    this.closeGuide();
    const note = s.journalOn ? (await periodNotePath(this.p.app, s, "daily", td))?.file ?? null : null;
    this.noticeWithNote(`Day planned${wasStarted ? "" : " and started"}.${s.journalOn && write ? " Saved to your journal." : ""}`, note, "Open daily note", true);
  }
  /** End of day: the planner with a two-step guide (tick off forgotten tasks, review the day), then finalize. */
  async startShutdown() {
    if (this.p.focus.state) { new Notice("Samaya: stop or finish the running focus first."); return; }
    this.p.collapseTimeline();
    const td = today(); const day = onDay(allTasks(this.p.app, this.p.settings), td);
    this.p.guide = { step: day.every(t => t.status === "done") ? 1 : 0, // nothing left to check off: straight to the review
       review: false, fresh: true, kind: "shutdown" };
    await this.p.openPlanner(); this.p.bus.emit();
  }
  /** Closing a day (by hand or automatically, because it was forgotten) writes its finished tasks and a summary of its review into that day's note. */
  async writeDayClose(date: string) {
    const s = this.p.settings;
    const all = allTasks(this.p.app, s);
    const finished = sortTasks(onDay(all, date).filter(t => t.status === "done"));
    if (journalWants(s, "journalFinished")) await writeSection(this.p.app, s, date, "Finished tasks", taskLines(await toJournalTasks(this.p.app, finished, true)));
    if (journalWants(s, "journalReview")) {
      const { items, hasPlan } = reviewItems(this.p, all, date); const log = this.p.workday.allLogs().find(l => l.date === date) ?? null; const now = nowMin();
      const body = reviewSummary({ items, hasPlan, window: this.p.workWindowFor(date), start: log?.start ? hmToMin(log.start) : null, end: log?.start ? (log.end ? hmToMin(log.end) : date === today() ? now : null) : null,
        worked: workedOn(log, now, this.p.dayRules), ref: t => `[[${t}]]` });
      await writeSection(this.p.app, s, date, "Productivity review", body);
    }
  }
  async finishShutdown() {
    const s = this.p.settings; const td = today();
    await this.writeDayClose(td);
    await this.p.workday.endDay();
    this.closeGuide();
    const note = s.journalOn ? (await periodNotePath(this.p.app, s, "daily", td))?.file ?? null : null;
    this.noticeWithNote(`Day ended${s.journalOn ? " - saved to your journal" : ""}. See you tomorrow.`, note, "Open daily note");
  }
}
