import esbuild from "esbuild";
import assert from "node:assert/strict";
const bundle = async (entry, out) => esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, alias: { obsidian: "./test/obsidian-stub.mjs" }, logLevel: "error" });
await bundle("src/util.ts", "test/.util.mjs");
await bundle("src/colors.ts", "test/.colors.mjs"); await bundle("src/worktime.ts", "test/.worktime.mjs"); await bundle("src/segments.ts", "test/.segments.mjs"); await bundle("src/sessions.ts", "test/.sessions.mjs"); await bundle("src/model.ts", "test/.model.mjs"); await bundle("src/taskprops.ts", "test/.taskprops.mjs");
await bundle("src/taskbody.ts", "test/.taskbody.mjs"); await bundle("src/timeline.ts", "test/.timeline.mjs");
await bundle("src/settings.ts", "test/.settings.mjs"); await bundle("src/weekplan.ts", "test/.weekplan.mjs");
await bundle("src/monthgrid.ts", "test/.monthgrid.mjs"); await bundle("src/kanban.ts", "test/.kanban.mjs"); await bundle("src/gantt.ts", "test/.gantt.mjs"); await bundle("src/journal.ts", "test/.journal.mjs"); await bundle("src/tickets.ts", "test/.tickets.mjs");
const { horizonTarget, horizonOf, bucketOf, parseTitleEstimate, startOfWeek, addDays, fmtDur, fmtHm, parseDuration, slugify } = await import("./.util.mjs");
const { latestOnOrBefore, neighbours } = await import("./.journal.mjs");
const { fmtEstimate, meetingLines, sortByStart, taskLines, bulletLines, upsertSection, readSection, pickJournalSource: pick } = await import("./.journal.mjs");
const { fetchJira, fetchGitlab, adfToText } = await import("./.tickets.mjs");
const { renderTicketPath, renderTicketFileName, renderTicketNote, pathRoot: pathRoot2 } = await import("./.taskbody.mjs");

// ---- workedSince: time since the start line minus breaks and lunch, overlaps once
{ const { workedSince, workedOn, totalBalance } = await import("./.worktime.mjs");
  const log = { date: "2026-11-10", start: "09:00", end: "17:00", breaks: [{ start: "12:00", end: "13:00", kind: "lunch" }], open: null };
  const rules = () => ({ from: 510, lunch: [720, 780] }); // start line 08:30, lunch 12:00-13:00
  assert.equal(workedOn(log, 1440), 420); // old rule: logged start, logged breaks
  assert.equal(workedOn(log, 1440, rules), 450); // 08:30-17:00 = 510 - 60 lunch (the tracked lunch counts once): the start line wins over the logged 09:00
  assert.equal(totalBalance([log], 40, 5, () => ({ from: 540, lunch: [720, 780] })), 420 - 480);
  assert.equal(workedSince(480, 600, [720, 780], []), 120); // before lunch
  assert.equal(workedSince(480, 840, [720, 780], []), 300); // lunch subtracted
  assert.equal(workedSince(480, 840, [720, 780], [[720, 780]]), 300); // a tracked lunch break is not subtracted twice
  assert.equal(workedSince(480, 840, [720, 780], [[700, 730], [600, 610]]), 270); // partial overlap counted once
  assert.equal(workedSince(480, 400, [720, 780], []), 0); }
// ---- util
assert.deepEqual(parseTitleEstimate("Write report 1h"), { title: "Write report", estimate: 60 });
assert.deepEqual(parseTitleEstimate("Call mom"), { title: "Call mom" });
assert.equal(startOfWeek("2026-11-03"), "2026-11-02");
assert.equal(horizonTarget("week", "2026-11-10"), "2026-11-16");
assert.equal(horizonTarget("month", "2026-11-10"), "2026-12-01");
assert.equal(horizonTarget("quarter", "2026-11-10"), "2027-01-01");
assert.equal(horizonTarget("month", "2026-12-20"), "2027-01-01");
assert.equal(horizonOf("2026-11-16", "2026-11-10"), "week");
assert.equal(horizonOf("2026-12-01", "2026-11-10"), "month");
assert.equal(horizonOf("2027-01-01", "2026-11-10"), "quarter");
assert.equal(horizonOf("2026-12-01", "2026-11-25"), "week"); // cascades closer as the date nears
assert.equal(horizonOf("2027-01-01", "2026-12-05"), "month");
assert.equal(horizonTarget("year", "2026-11-10"), "2027-01-01");
assert.equal(horizonTarget("someday", "2026-11-10"), "");
assert.equal(bucketOf("year", "2027-01-01", "2026-11-10"), "year"); // no cascade, even though it is also next quarter's date
assert.equal(bucketOf("quarter", "2027-01-01", "2026-12-05"), "month");
assert.equal(bucketOf("never", "", "2026-11-10"), "never");
assert.equal(bucketOf("", "", "2026-11-10"), "someday");
assert.equal(bucketOf("", "2026-11-16", "2026-11-10"), "week");
assert.equal(addDays("2026-11-30", 1), "2026-12-01");
assert.equal(fmtDur(90), "1h 30m");

assert.equal(fmtHm(90), "01:30"); assert.equal(fmtHm(5), "00:05");
assert.equal(parseDuration("1:30"), 90); assert.equal(parseDuration("1.5h"), 90); assert.equal(parseDuration("45m"), 45); assert.equal(parseDuration("45"), 45); assert.equal(parseDuration("x"), null);
assert.equal(slugify("Weekly Sync: Q4 Planning / Ärger!"), "weekly-sync-q4-planning-arger"); assert.equal(slugify("!!!"), "meeting");

// ---- task body / templates / layout
const { ensureSubtasksHeading, insertSubtask, renderTemplate, renderPath, pathRoot, DEFAULT_TASK_TEMPLATE } = await import("./.taskbody.mjs");
const { layoutItems } = await import("./.timeline.mjs");
let body = DEFAULT_TASK_TEMPLATE;
body = insertSubtask(body, "one"); body = insertSubtask(body, "two");
assert.equal(body, "## Subtasks\n- [ ] one\n- [ ] two\n\n## Notes\n");
assert.equal(ensureSubtasksHeading("# T\n\n## Notes\nhi"), "# T\n\n## Subtasks\n\n\n## Notes\nhi");
assert.equal(ensureSubtasksHeading("plain"), "plain\n\n## Subtasks\n\n");
assert.equal(insertSubtask("# T\n", "a"), "# T\n\n## Subtasks\n- [ ] a\n\n");
const fmt = (d, f) => f === "YYYY" ? String(d.getFullYear()) : "X";
assert.equal(renderTemplate("# {{title}} {{date:YYYY}} {{start}}-{{end}} {{ time }}", { title: "Sync", date: new Date(2026, 10, 3), start: "09:00", end: "10:00" }, fmt), "# Sync 2026 09:00-10:00 X");
const mfmt = (d, f) => f.replace(/\[([^\]]*)\]|YYYY|MM/g, (m, lit) => lit ?? (m === "YYYY" ? String(d.getFullYear()) : String(d.getMonth() + 1).padStart(2, "0")));
assert.equal(renderPath("[Meetings]/YYYY/YYYY-MM", new Date(2026, 10, 3), mfmt), "Meetings/2026/2026-11");
assert.equal(pathRoot("[Meetings]/YYYY/YYYY-MM", mfmt), "Meetings");
assert.equal(pathRoot("[Work]/[Tasks]/YYYY/MM", mfmt), "Work/Tasks");
assert.equal(pathRoot("YYYY/[Tasks]", mfmt), "");
assert.equal(pathRoot("[Tickets]", mfmt), "Tickets");
const L = layoutItems([{ s: 0, dur: 60 }, { s: 30, dur: 60 }, { s: 120, dur: 30 }]);
assert.deepEqual([...L.values()], [{ col: 0, n: 2 }, { col: 1, n: 2 }, { col: 0, n: 1 }]);

// ---- colours and capacity bar
{
  const { normalizeHex } = await import("./.colors.mjs"); const { capBarShape } = await import("./.weekplan.mjs");
  assert.equal(normalizeHex("#A1b2C3"), "#a1b2c3"); assert.equal(normalizeHex(" fa0 "), "#ffaa00"); assert.equal(normalizeHex("#12345"), ""); assert.equal(normalizeHex("rgb(1,2,3)"), "");
  assert.deepEqual(capBarShape(120, 120, 360, 0.8), { meet: 25, task: 25, mark: (120 + 288) / 480 * 100 }); // 6h free + 2h meetings = the 8h bar
  assert.deepEqual(capBarShape(600, 120, 360, 0.8).task, 75); assert.deepEqual(capBarShape(0, 0, 0), { meet: 0, task: 0, mark: null }); assert.equal(capBarShape(30, 0, 0).task, 100);
}
// ---- worktime
const W = await import("./.worktime.mjs");
{ // vacation days and the average work time of a week
  const vac = W.vacationDates([{ title: "Urlaub", start: new Date(2026, 10, 4), end: new Date(2026, 10, 6), allDay: true }, { title: "Urlaub", start: new Date(2026, 10, 9, 9), end: new Date(2026, 10, 9, 10), allDay: false }, { title: "Lunch", start: new Date(2026, 10, 3), end: new Date(2026, 10, 4), allDay: true }], "urlaub");
  assert.deepEqual([...vac], ["2026-11-04", "2026-11-05"]); assert.equal(W.vacationDates([{ title: "Urlaub", start: new Date(2026, 10, 4), end: new Date(2026, 10, 5), allDay: true }], "").size, 0);
  const log = (date, start, end) => ({ date, start, end, breaks: [], open: null });
  const logs = [log("2026-11-02", "08:00", "16:00"), log("2026-11-03", "08:00", "14:00"), log("2026-11-04", "08:00", "20:00"), log("2026-11-07", "08:00", "12:00")];
  const avg = W.weekAverageWorked(logs, "2026-11-02", 5, vac); // Wed is vacation (left out), Sat is a weekend, Thu/Fri have no log
  assert.deepEqual(avg, { avg: 420, days: 2 }); assert.equal(W.weekAverageWorked([], "2026-11-02", 5, new Set()), null);
}
const log = { date: "2026-11-03", start: "08:30", end: "17:00", breaks: [{ start: "12:00", end: "12:45", kind: "lunch" }, { start: "15:00", end: "15:10", kind: "break" }], open: null };
assert.equal(W.workedMinutes(log, 0), 8 * 60 + 30 - 55);
assert.equal(W.workedMinutes({ date: "d", start: "09:00", end: null, breaks: [], open: { start: "10:00", kind: "break" } }, 10 * 60 + 20), 60); // open break not counted
assert.deepEqual(W.parseBreak("12:00-12:45 lunch"), { start: "12:00", end: "12:45", kind: "lunch" });
assert.equal(W.fmtBreak({ start: "15:00", end: "15:10", kind: "break" }), "15:00-15:10");
assert.equal(W.parseBreak("nope"), null);
assert.equal(W.dailyTarget(40, 5, "2026-11-03"), 480); assert.equal(W.dailyTarget(40, 5, "2026-11-07"), 0); assert.equal(W.dailyTarget(30, 4, "2026-11-06"), 0);
assert.equal(W.unionMinutes([[0, 60], [30, 90], [120, 150]]), 120);
const cap = W.capacityWindow(540, 900, [720, 780], [[600, 660], [630, 690], [740, 800]]); // meetings: 10:00-11:30 (union 90) + 12:20-13:20 -> 20 min beyond lunch end
assert.deepEqual(cap, { total: 360, lunch: 60, meetings: 90 + 20, free: 360 - 60 - 110 });
assert.deepEqual(W.autoLunch({ ...log, breaks: [] }, [720, 780]), { start: "12:00", end: "13:00", kind: "lunch" });
assert.equal(W.autoLunch(log, [720, 780]), null);
assert.equal(W.autoLunch({ ...log, start: "13:30", breaks: [] }, [720, 780]), null);
const logs = [log, { date: "2026-11-04", start: "09:00", end: "18:00", breaks: [{ start: "12:00", end: "13:00", kind: "lunch" }], open: null }, { date: "2026-11-05", start: "09:00", end: null, breaks: [], open: null }];
const wk = W.weekSummary(logs, "2026-11-02", 40, 5, "2026-11-05", 10 * 60);
assert.equal(wk.rows[1].delta, 8 * 60 + 30 - 55 - 480); assert.equal(wk.rows[2].delta, 0); assert.equal(wk.rows[3].delta, null); assert.equal(wk.rows[3].worked, 60);
assert.equal(wk.target, 2400); assert.equal(wk.balance, (8 * 60 + 30 - 55 - 480) + 0);
assert.equal(W.totalBalance(logs, 40, 5), (8 * 60 + 30 - 55 - 480) + 0);
assert.equal(W.fmtSigned(-18), "-0:18"); assert.equal(W.fmtSigned(75), "+1:15");

// ---- period stats
{
  const { periodRange, periodStats } = await import("./.worktime.mjs");
  assert.deepEqual(periodRange("weekly", "2026-11-08"), { from: "2026-11-02", to: "2026-11-08" });
  assert.deepEqual(periodRange("monthly", "2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodRange("quarterly", "2026-11-08"), { from: "2026-10-01", to: "2026-12-31" });
  assert.deepEqual(periodRange("yearly", "2026-11-08"), { from: "2026-01-01", to: "2026-12-31" });
  const L = (date, start, end, br = []) => ({ date, start, end, breaks: br, open: null });
  const st = periodStats([L("2026-11-02", "08:00", "17:00", [{ start: "12:00", end: "13:00", kind: "lunch" }]), L("2026-11-03", "09:00", "18:00", [{ start: "12:00", end: "13:00", kind: "lunch" }]), L("2026-11-04", "09:00", null), L("2026-10-30", "08:00", "12:00")], "2026-11-02", "2026-11-08", 40, 5);
  assert.equal(st.days, 2); assert.equal(st.avgStart, "08:30"); assert.equal(st.avgEnd, "17:30"); assert.equal(st.worked, 960); assert.equal(st.target, 960); assert.equal(st.balance, 0);
  assert.equal(periodStats([], "2026-11-02", "2026-11-08", 40, 5).avgStart, null);
}

// ---- latest note
{
  const it = [{ date: "2026-11-01" }, { date: "2026-11-07" }, { date: "2026-11-20" }];
  assert.equal(latestOnOrBefore(it, "2026-11-08").date, "2026-11-07"); assert.equal(latestOnOrBefore(it, "2026-10-01"), null);
}

{
  const it = [{ date: "2026-11-01" }, { date: "2026-11-07" }, { date: "2026-11-20" }];
  assert.equal(neighbours(it, "2026-11-07").prev.date, "2026-11-01"); assert.equal(neighbours(it, "2026-11-07").next.date, "2026-11-20");
  assert.equal(neighbours(it, "2026-11-01").prev, null); assert.equal(neighbours(it, "2026-11-20").next, null);
  assert.equal(neighbours(it, "2026-11-10").prev.date, "2026-11-07");
}

// ---- month grid
{
  const { isoWeek, monthGrid } = await import("./.monthgrid.mjs");
  assert.equal(isoWeek("2026-01-01"), 1); assert.equal(isoWeek("2026-12-31"), 53); assert.equal(isoWeek("2027-01-03"), 53); assert.equal(isoWeek("2027-01-04"), 1);
  const g = monthGrid(2026, 10); // November 2026 starts on a Sunday
  assert.equal(g.length, 6); assert.equal(g[0].start, "2026-10-26"); assert.equal(g[0].days[6].date, "2026-11-01"); assert.equal(g[0].days[6].inMonth, true); assert.equal(g[0].days[0].inMonth, false);
  assert.equal(g[0].week, 44);
}

// ---- kanban
{
  const { orderStatuses, groupTickets } = await import("./.kanban.mjs");
  assert.deepEqual(orderStatuses(["Done", "In Progress", "To Do", "Review", "Blocked"]), ["To Do", "Blocked", "In Progress", "Review", "Done"]);
  const g = groupTickets([{ state: "Done", project: "B" }, { state: "To Do", project: "" }, { state: "To Do", project: "A" }, { state: "Done", project: "A" }]);
  assert.deepEqual(g.columns, ["To Do", "Done"]); assert.deepEqual(g.lanes.map(l => l.project), ["A", "B", "No project"]);
  assert.equal(g.lanes[0].cells.get("To Do").length, 1);
}

// ---- gantt
{
  const { parseSpan, ganttRange, dragSpan, monthMarks, daysBetween } = await import("./.gantt.mjs");
  assert.deepEqual(parseSpan("2026-11-02", "2026-11-09"), { start: "2026-11-02", end: "2026-11-09" });
  assert.deepEqual(parseSpan("2026-11-02", undefined), { start: "2026-11-02", end: "2026-11-02" });
  assert.deepEqual(parseSpan("2026-11-02", "2026-10-01"), { start: "2026-11-02", end: "2026-11-02" });
  assert.equal(parseSpan("", "2026-11-09"), null);
  const r = ganttRange([{ start: "2026-11-11", end: "2026-12-01" }], "2026-11-08");
  assert.equal(r.from, "2026-10-26"); assert.equal(r.days % 7, 0); assert.ok(daysBetween(r.from, "2026-12-01") < r.days);
  assert.deepEqual(dragSpan({ start: "2026-11-02", end: "2026-11-05" }, "move", 3), { start: "2026-11-05", end: "2026-11-08" });
  assert.deepEqual(dragSpan({ start: "2026-11-02", end: "2026-11-05" }, "start", 9), { start: "2026-11-05", end: "2026-11-05" });
  assert.deepEqual(dragSpan({ start: "2026-11-02", end: "2026-11-05" }, "end", -9), { start: "2026-11-02", end: "2026-11-02" });
  const mm = monthMarks("2026-10-26", 14); assert.equal(mm.length, 2); assert.equal(mm[1].offset, 6); assert.equal(mm[0].span + mm[1].span, 14);
}

// ---- journal
{
  const L = { folder: "x", format: "y" };
  assert.equal(pick({ daily: L, periodic: L }, "auto"), "periodic"); // Periodic Notes replaces the core plugin when both exist
  assert.equal(pick({ daily: L, periodic: L }, "daily"), "daily");
  assert.equal(pick({ daily: L, periodic: null }, "periodic"), "daily"); // chosen source gone: next best
  assert.equal(pick({ daily: null, periodic: null }, "auto"), "custom");
  assert.equal(pick({ daily: L, periodic: L }, "custom"), "custom");
}
assert.equal(fmtEstimate(20), "20 min"); assert.equal(fmtEstimate(120), "2 hr"); assert.equal(fmtEstimate(90), "1.5 hr"); assert.equal(fmtEstimate(0), "");
assert.equal(taskLines([{ title: "Task A", minutes: 20, subtasks: [] }, { title: "Task B", minutes: 120, subtasks: ["Subtask 1", "Subtask 2"] }]),
  "- [[Task A]] • *20 min*\n- [[Task B]] • *2 hr*\n    - Subtask 1\n    - Subtask 2");
assert.equal(taskLines([{ title: "T", minutes: 30, subtasks: [], time: "10:00-10:30" }]), "- [[T]] • *10:00-10:30* • *30 min*");
assert.equal(meetingLines([{ title: "Sync", start: new Date(2026, 0, 1, 9, 30), end: new Date(2026, 0, 1, 10, 0), allDay: false, note: "2026-01-01_sync" }]), "- *09:30-10:00* [[2026-01-01_sync|Sync]]");
assert.deepEqual(sortByStart([{ start: "" , n: 1 }, { start: "13:00", n: 2 }, { start: "9:30", n: 3 }, { start: "", n: 4 }]).map(x => x.n), [3, 2, 1, 4]);
assert.equal(bulletLines(["", "- a", "b "]), "- a\n- b");
let note = upsertSection("", "Planned tasks", "- [[A]]");
note = upsertSection(note, "Planned for tomorrow", "- [[C]]");
note = upsertSection(note, "Finished tasks", "- [[A]] • *5 min*"); // must land before "Planned for tomorrow"
const order = note.split("\n").filter(l => l.startsWith("## "));
assert.deepEqual(order, ["## Planned tasks", "## Finished tasks", "## Planned for tomorrow"]);
note = upsertSection(note, "Planned tasks", "- [[A]]\n- [[B]]"); // replaces, doesn't duplicate
assert.equal(note.split("## Planned tasks").length, 2);
assert.deepEqual(readSection(note, "Planned tasks"), ["[[A]]", "[[B]]"]);
assert.ok(upsertSection("# My day\nfree text\n", "Planned tasks", "- x").startsWith("# My day\nfree text"));

// ---- task properties
{
  const T = await import("./.taskprops.mjs");
  const A = { date: "2026-11-11", s: 780, dur: 60 }, B = { date: "2026-11-11", s: 900, dur: 60 };
  assert.deepEqual(T.parseSessions(["2026-11-11 13:00-14:00", "2026-11-11 15:00-16:00"]), { planned: "2026-11-11", start: "13:00", segments: [{ s: 780, dur: 60 }, { s: 900, dur: 60 }], sessions: [A, B] });
  assert.deepEqual(T.parseSessions(["2026-11-11 13:00-14:00"]), { planned: "2026-11-11", start: "13:00", segments: [], sessions: [A] });
  assert.deepEqual(T.parseSessions(["2026-11-11"]), { planned: "2026-11-11", start: "", segments: [], sessions: [{ date: "2026-11-11", s: null, dur: 0 }] });
  assert.deepEqual(T.parseSessions(undefined), { planned: "", start: "", segments: [], sessions: [] });
  // legacy notes are still read
  assert.deepEqual(T.readPlanning({ planned: "2026-11-11", start: "9:00", segments: ["09:00-10:00", "11:00-12:00"] }), { planned: "2026-11-11", start: "9:00", segments: [{ s: 540, dur: 60 }, { s: 660, dur: 60 }], sessions: [] });
  // writing: single timed session, length follows the estimate; legacy keys are migrated
  let fm = { planned: "2026-11-11", start: "13:00", estimate: 60, ticket: "[[T]]", completed: "2026-01-01", samaya_project: "[[P]]", order: 2 };
  T.applyTaskPatch(fm, { estimate: 90 });
  assert.deepEqual(fm, { duration_estimate: 90, assigned_ticket: "[[T]]", day_completed: "2026-01-01", assigned_project: "[[P]]", order: 2, planned_sessions: ["2026-11-11 13:00-14:30"] });
  // split
  T.applyTaskPatch(fm, { start: "10:00", estimate: 120, segments: ["10:00-11:00", "13:00-14:00"] });
  assert.deepEqual(fm.planned_sessions, ["2026-11-11 10:00-11:00", "2026-11-11 13:00-14:00"]);
  // moved to another day: the time slot goes
  T.applyTaskPatch(fm, { planned: "2026-11-12" });
  assert.deepEqual(fm.planned_sessions, ["2026-11-12"]);
  // new slot with the move
  T.applyTaskPatch(fm, { planned: "2026-11-13", start: "08:30" });
  assert.deepEqual(fm.planned_sessions, ["2026-11-13 08:30-10:30"]);
  // unscheduled from the timeline, then unplanned
  T.applyTaskPatch(fm, { start: null }); assert.deepEqual(fm.planned_sessions, ["2026-11-13"]);
  T.applyTaskPatch(fm, { planned: null }); assert.equal(fm.planned_sessions, undefined);
  T.applyTaskPatch(fm, { estimate: null, ticket: null }); assert.ok(!("duration_estimate" in fm) && !("assigned_ticket" in fm));

  // ---- a task in parts on several days
  const multi = () => ({ duration_estimate: 180, order: 1, planned_sessions: ["2026-11-11 10:00-11:00", "2026-11-12 90m"], week: "2026-11-09" });
  // the first day is the planned one; the other day's piece is kept
  let mf = multi(); const mp = T.parseSessions(mf.planned_sessions);
  assert.equal(mp.planned, "2026-11-11"); assert.deepEqual(mp.sessions[1], { date: "2026-11-12", s: null, dur: 90 });
  // writes that say nothing about the plan do not reshape the pieces
  T.applyTaskPatch(mf, { order: 3, actual: 20 }); assert.deepEqual(mf.planned_sessions, ["2026-11-11 10:00-11:00", "2026-11-12 90m"]);
  T.applyTaskPatch(mf, { estimate: 240 }); assert.deepEqual(mf.planned_sessions, ["2026-11-11 10:00-11:00", "2026-11-12 90m"]); // a new estimate only changes the rest
  // the whole list at once
  T.applyTaskPatch(mf, { sessions: ["2026-11-13 30m", "2026-11-11 09:00-10:00"], estimate: 90 });
  assert.deepEqual(mf.planned_sessions, ["2026-11-11 09:00-10:00", "2026-11-13 30m"]); assert.equal(mf.duration_estimate, 90);
  T.applyTaskPatch(mf, { sessions: [] }); assert.equal(mf.planned_sessions, undefined);
  // the whole task moved to another day (or off the calendar): the pieces go with it
  mf = multi(); T.applyTaskPatch(mf, { planned: "2026-11-20" }); assert.deepEqual(mf.planned_sessions, ["2026-11-20"]);
  mf = multi(); T.applyTaskPatch(mf, { planned: null }); assert.equal(mf.planned_sessions, undefined);
  // time and length written for the first day keep the other days
  mf = multi(); T.applyTaskPatch(mf, { planned: "2026-11-11", start: "14:00", estimate: 180 });
  assert.deepEqual(mf.planned_sessions, ["2026-11-11 14:00-15:30", "2026-11-12 90m"]);
  // sessions without a length are what is left of the estimate
  assert.deepEqual(T.sessionsOf(T.parseSessions(["2026-11-11"]), 75), [{ date: "2026-11-11", s: null, dur: 75 }]);
}

// ---- tasks in parts: the view of one day, the unplanned rest, what was left behind
{
  const M = await import("./.model.mjs"); const P = await import("./.sessions.mjs");
  const mk = (title, sessions, o = {}) => ({ file: { path: title }, title, status: "todo", planned: sessions[0]?.date ?? "", start: "", segments: [], estimate: 0, actual: 0, order: 0, channel: "", ticket: "", week: "", later: "", horizon: "", sessions, rest: 0, ...o });
  const plain = mk("plain", [{ date: "2026-11-11", s: 600, dur: 60 }], { estimate: 60, start: "10:00" });
  const spread = mk("spread", [{ date: "2026-11-11", s: 600, dur: 60 }, { date: "2026-11-12", s: null, dur: 90 }], { estimate: 210, rest: 60, week: "2026-11-09", start: "10:00" });
  const all = [plain, spread];
  // a task planned on one day is returned as it is; a spread one shows only that day's minutes
  assert.equal(M.onDay(all, "2026-11-11")[0], plain);
  const mon = M.onDay(all, "2026-11-11")[1], tue = M.onDay(all, "2026-11-12")[0];
  assert.deepEqual([mon.estimate, mon.planned, mon.start, mon.part.kind, mon.part.total], [60, "2026-11-11", "10:00", "day", 210]);
  assert.deepEqual([tue.estimate, tue.planned, tue.start, tue.part.nth, tue.part.count], [90, "2026-11-12", "", 1, 3]);
  assert.deepEqual(tue.part.others, [{ date: "2026-11-11", dur: 60 }]);
  assert.equal(M.onDay(all, "2026-11-13").length, 0);
  // capacity: the minutes of a day over all tasks
  const minutes = d => M.onDay(all, d).reduce((a, t) => a + t.estimate, 0);
  assert.deepEqual([minutes("2026-11-11"), minutes("2026-11-12")], [120, 90]);
  // the unplanned rest is its own entry in the week's list
  const rest = M.unplanned(all); assert.equal(rest.length, 1); assert.deepEqual([rest[0].estimate, rest[0].planned, rest[0].part.kind, rest[0].week], [60, "", "rest", "2026-11-09"]);
  // week buckets-style counting: 60 + 90 on their days + 60 waiting = the estimate of the spread task, no minute twice
  assert.equal(minutes("2026-11-11") + minutes("2026-11-12") + rest[0].estimate, 60 + 60 + 90 + 60);
  // left behind: pieces of earlier days, one card per day
  assert.deepEqual(M.overdueParts(all, "2026-11-12").map(t => t.title + "@" + t.planned), ["plain@2026-11-11", "spread@2026-11-11"]);
  assert.deepEqual(M.overdueParts([{ ...spread, status: "done" }], "2026-11-13"), []);
}

// ---- sessions: pieces on several days
{
  const P = await import("./.sessions.mjs");
  assert.deepEqual(P.parseSession("2026-11-12 90m"), { date: "2026-11-12", s: null, dur: 90 });
  assert.deepEqual(P.parseSession("2026-11-12 09:30-10:15"), { date: "2026-11-12", s: 570, dur: 45 });
  assert.equal(P.parseSession("nonsense"), null);
  assert.equal(P.formatSession({ date: "2026-11-12", s: null, dur: 90 }), "2026-11-12 90m");
  assert.equal(P.formatSession({ date: "2026-11-12", s: 570, dur: 45 }), "2026-11-12 09:30-10:15");
  const ss = [{ date: "2026-11-11", s: 600, dur: 60 }, { date: "2026-11-11", s: 780, dur: 60 }, { date: "2026-11-12", s: null, dur: 30 }];
  assert.equal(P.dayMinutes(ss, "2026-11-11"), 120); assert.deepEqual(P.sessionDays(ss), ["2026-11-11", "2026-11-12"]);
  // a piece taken off a day, or the whole day
  assert.deepEqual(P.takePiece(ss, "2026-11-11", 1), { left: [ss[0], ss[2]], mins: 60 });
  assert.deepEqual(P.takePiece(ss, "2026-11-11", null), { left: [ss[2]], mins: 120 });
  // minutes arriving on a day that has pieces: one piece without a time
  assert.deepEqual(P.addMinutes(ss, "2026-11-11", 45).filter(g => g.date === "2026-11-11"), [{ date: "2026-11-11", s: null, dur: 165 }]);
  assert.deepEqual(P.addMinutes(ss, "2026-11-13", 45).pop(), { date: "2026-11-13", s: null, dur: 45 });
  // cutting a piece in two
  const cut = P.splitPiece([{ date: "2026-11-11", s: 600, dur: 120 }], "2026-11-11", null, 45);
  assert.deepEqual(cut, { sessions: [{ date: "2026-11-11", s: 600, dur: 45 }], left: 75, at: 645 });
  assert.equal(P.splitPiece([{ date: "2026-11-11", s: 600, dur: 120 }], "2026-11-11", null, 120), null);
  assert.equal(P.splitPiece([{ date: "2026-11-11", s: null, dur: 60 }], "2026-11-11", null, 15).at, null);
  // what is being dragged
  assert.equal(P.pieceLength(ss, 0, 150, "2026-11-11", 1, 30), 60); // one block
  assert.equal(P.pieceLength(ss, 0, 150, "2026-11-11", null, 30), 120); // a whole day
  assert.equal(P.pieceLength(ss, 45, 150, "", null, 30), 45); // the rest
  assert.equal(P.pieceLength([], 0, 0, null, null, 30), 30); // nothing planned: the default
  // a day without a length takes what the other pieces leave over
  assert.deepEqual(P.resolveSessions([{ date: "2026-11-11", s: null, dur: 0 }, { date: "2026-11-12", s: null, dur: 30 }], 90), [{ date: "2026-11-11", s: null, dur: 60 }, { date: "2026-11-12", s: null, dur: 30 }]);
}

// ---- split tasks
{
  const S = await import("./.segments.mjs");
  assert.deepEqual(S.parseSegments(["13:00-13:45", "10:15-11:00", "bad"]), [{ s: 615, dur: 45 }, { s: 780, dur: 45 }]);
  assert.deepEqual(S.fmtSegments([{ s: 615, dur: 45 }]), ["10:15-11:00"]);
  const busy = [[660, 720], [720, 780]]; // meeting 11:00-12:00 + lunch 12:00-13:00
  assert.deepEqual(S.planSegments(600, 120, busy, 1200, 15), [{ s: 600, dur: 60 }, { s: 780, dur: 60 }]); // 10:00 task of 2h: 1h before, 1h after
  assert.deepEqual(S.planSegments(600, 30, busy, 1200, 15), [{ s: 600, dur: 30 }]); // fits before the conflict: no split
  assert.deepEqual(S.planSegments(670, 30, busy, 1200, 15), [{ s: 780, dur: 30 }]); // dropped on the meeting: moves behind it
  assert.deepEqual(S.planSegments(650, 60, busy, 1200, 15), [{ s: 780, dur: 60 }]); // gap of 10 min is too small
  assert.equal(S.planSegments(1100, 180, busy, 1200, 15), null); // does not fit before the end
  // window 08:00-17:00: a task that does not fit before the finish line moves parts into earlier gaps first
  assert.deepEqual(S.planInWindow(960, 120, [], 480, 1020, 0, 1200, 15), [{ s: 900, dur: 120 }]); // 16:00 + 2h -> 15:00-17:00
  assert.deepEqual(S.planInWindow(960, 120, [[900, 960]], 480, 1020, 0, 1200, 15), [{ s: 840, dur: 60 }, { s: 960, dur: 60 }]); // meeting 15-16: 14:00-15:00 + 16:00-17:00
  assert.deepEqual(S.planInWindow(960, 120, [], 480, 1020, 930, 1200, 15), [{ s: 930, dur: 120 }]); // now = 15:30: only 30 min before, the rest crosses 17:00
  assert.deepEqual(S.planInWindow(300, 60, [], 480, 1020, 0, 1200, 15), [{ s: 480, dur: 60 }]); // before the start line: moves to it
  assert.deepEqual(S.planInWindow(600, 120, [[660, 720]], 480, 1020, 0, 1200, 15), [{ s: 600, dur: 60 }, { s: 720, dur: 60 }]); // plain split
  const segs = [{ s: 600, dur: 60 }, { s: 780, dur: 60 }];
  assert.deepEqual(S.mergeOffer([{ s: 600, dur: 60 }, { s: 660, dur: 60 }], 1, busy, 1200), { at: 600 }); // touching
  assert.deepEqual(S.mergeOffer([{ s: 600, dur: 60 }, { s: 900, dur: 60 }], 1, busy, 1200), { at: 900 }); // open block for all 120 min
  assert.equal(S.mergeOffer(segs.map(x => ({ ...x })), 0, busy, 1200), null); // 10:00 + 120 min runs into the meeting
}

// ---- tickets
const calls = [];
const jiraHttp = async o => { calls.push(o.url);
  if (!o.url.includes("nextPageToken")) return { status: 200, headers: {}, json: { issues: [{ key: "OPS-1", fields: { summary: "One", status: { name: "To Do" }, project: { key: "OPS" } } }], nextPageToken: "abc" } };
  return { status: 200, headers: {}, json: { issues: [{ key: "OPS-2", fields: { summary: "Two", status: { name: "Doing" } } }], isLast: true } }; };
const jira = await fetchJira({ flavor: "cloud", url: "https://x.atlassian.net", email: "a@b.c", token: "t", jql: "a = b" }, jiraHttp);
assert.deepEqual(jira.map(t => t.key), ["OPS-1", "OPS-2"]); assert.equal(jira[0].url, "https://x.atlassian.net/browse/OPS-1"); assert.equal(jira[1].project, "OPS");
assert.ok(calls[0].includes("/rest/api/3/search/jql?jql=a%20%3D%20b"));
const glHttp = async o => o.url.endsWith("page=1")
  ? { status: 200, headers: { "X-Next-Page": "2" }, json: [{ iid: 12, title: "Bug", web_url: "https://gl/x/-/issues/12", state: "opened", references: { full: "grp/proj#12" } }] }
  : { status: 200, headers: { "x-next-page": "" }, json: [{ iid: 3, title: "Feat", web_url: "u", state: "opened", references: { full: "grp/other#3" } }] };
const gl = await fetchGitlab({ url: "https://gl", token: "t", scope: "assigned_to_me" }, glHttp);
assert.deepEqual(gl.map(t => [t.id, t.key]), [["grp/proj#12", "proj#12"], ["grp/other#3", "other#3"]]);
await assert.rejects(fetchJira({ flavor: "cloud", url: "", email: "", token: "", jql: "" }, jiraHttp));
// ---- ticket templates
const tv = { id: "OPS-1", title: "Fix the Deploy!", type: "Bug", status: "In Progress", assignedTo: "Ada", url: "https://x/OPS-1", description: "Desc", source: "Jira", project: "OPS" };
assert.equal(renderTicketFileName("", tv), "OPS-1_fix-the-deploy");
assert.equal(renderTicketFileName("{{TICKET_ID}} {{TICKET_TITLE}}", tv), "OPS-1 Fix the Deploy!");
assert.equal(renderTicketPath("[Tickets]/[Jira]/{{TICKET_STATUS}}", tv, new Date(2026, 10, 8), mfmt), "Tickets/Jira/In Progress");
assert.equal(renderTicketPath("[Tickets]/YYYY/{{TICKET_ASSIGNEE}}", tv, new Date(2026, 10, 8), mfmt), "Tickets/2026/Ada");
assert.equal(renderTicketPath("[T]/{{TICKET_PROJECT}}", tv, new Date(2026, 10, 8), mfmt), "T/OPS");
assert.equal(pathRoot("[Tickets]/[Jira]/{{TICKET_STATUS}}", mfmt), "Tickets/Jira");
assert.equal(renderTicketPath("[Tickets]/{{TICKET_SOURCE}}/{{TICKET_STATUS}}", tv, new Date(2026, 10, 8), mfmt), "Tickets/JIRA/In Progress");
assert.equal(renderTicketNote("{{TASK_ID}}|{{TASK_STATUS}}", tv), "OPS-1|In Progress"); // legacy prefix
assert.equal(renderTicketNote("", tv), "# Fix the Deploy!\n\n[Open in JIRA](https://x/OPS-1)\n");
assert.equal(renderTicketNote("{{TICKET_TYPE}}|{{ TICKET_STATUS }}|{{TICKET_NOPE}}", tv), "Bug|In Progress|{{TICKET_NOPE}}");
assert.equal(adfToText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }] }] }), "A\n\n- x");
// ---- event notes
await bundle("src/eventnotes.ts", "test/.eventnotes.mjs");
const { compilePattern, eventFromNote, parseClock } = await import("./.eventnotes.mjs");
const mt = compilePattern("{{date}}_{{title}}");
assert.deepEqual(mt("2026-11-09_Sprint planning"), { date: "2026-11-09", title: "Sprint planning" });
assert.equal(mt("Sprint planning"), null);
assert.deepEqual(compilePattern("{{date}} {{start}} {{title}}")("2026-11-09 1030 Review"), { date: "2026-11-09", start: "1030", title: "Review" });
assert.equal(compilePattern("{{nope}}"), null);
assert.equal(parseClock("9:30"), 570); assert.equal(parseClock("0930"), 570); assert.equal(parseClock("x"), null);
const e1 = eventFromNote({ start: "10:00", end: "11:30" }, { date: "2026-11-09", title: "Sprint planning" }, "x");
assert.equal(e1.title, "Sprint planning"); assert.equal(e1.start.getHours(), 10); assert.equal((e1.end - e1.start) / 60000, 90);
assert.equal(eventFromNote({ start: "10:00" }, { date: "2026-11-09" }, "x"), null); // no end
assert.equal(eventFromNote({ start: "10:00", end: "11:00" }, {}, "x"), null); // no date anywhere
const e2 = eventFromNote({ date: "2026-11-10", title: "T", start: "23:00", end: "01:00" }, {}, "x"); assert.equal((e2.end - e2.start) / 60000, 120);
assert.ok(eventFromNote({ allday: true }, { date: "2026-11-09", title: "Off" }, "x").allDay);
console.log("all tests passed");

// ---- settings migration: optional modules that were already set up stay on
{
  const { migrateSettings, DEFAULT_SETTINGS } = await import("./.settings.mjs");
  assert.equal(DEFAULT_SETTINGS.jiraOn, false);
  const m = migrateSettings({ jiraUrl: "https://x.atlassian.net", jiraToken: "t", gitlabToken: "", eventNotesFolder: "Meetings" });
  assert.deepEqual([m.jiraOn, m.gitlabOn, m.calendarOn], [true, false, true]);
  assert.equal(migrateSettings({ calendarSource: "notes", eventNotesFolder: "Meetings" }).calendarOn, true);
  assert.equal(migrateSettings({}).calendarOn, false);
  assert.equal(migrateSettings({ journalFolder: "Journal" }).journalFolder, "[Journal]");
  { const jn = migrateSettings({ journalNotes: { weekly: { on: true } } }).journalNotes;
    assert.equal(jn.weekly.on, true); assert.equal(jn.weekly.format, "YYYY-[W]ww"); assert.equal(jn.yearly.on, false); assert.equal(jn.quarterly.format, "[Q]Q"); assert.equal(jn.weekly.folder, "[Journal]/YYYY/[Weekly]");
    const old = migrateSettings({ journalNotes: { weekly: { folder: "[Journal]/Weekly", format: "gggg-[W]ww" }, monthly: { folder: "[Mine]" } } }).journalNotes;
    assert.equal(old.weekly.format, "YYYY-[W]ww"); assert.equal(old.monthly.folder, "[Mine]"); }
  assert.equal(migrateSettings({ tasksPath: "T" }).journalOn, true); // existing installs keep the journal
  assert.equal(migrateSettings({}).journalOn, false); // fresh installs start without it
  assert.equal(migrateSettings({ journalFolder: "[Journal]/YYYY" }).journalFolder, "[Journal]/YYYY");
  assert.equal(migrateSettings({ ticketsPath: "[T]/{{TASK_STATUS}}", ticketFileName: "{{TASK_ID}}" }).ticketsPath, "[T]/{{TICKET_STATUS}}");
  assert.equal(migrateSettings({ jiraOn: false, jiraUrl: "u", jiraToken: "t" }).jiraOn, false); // explicit choice wins
}

// ---- week plan
{
  const { weekToPlan, loadLevel, isLeftover, BUFFER_SHARE, bufferShare } = await import("./.weekplan.mjs");
  assert.equal(weekToPlan("2026-11-10", 2), "2026-11-09"); // tuesday: this week
  assert.equal(weekToPlan("2026-11-14", 6), "2026-11-16"); // saturday: next week
  assert.equal(weekToPlan("2026-11-15", 0), "2026-11-16"); // sunday: next week
  assert.equal(BUFFER_SHARE, 0.8);
  assert.equal(bufferShare(20), 0.8); assert.equal(bufferShare(0), 1); assert.equal(bufferShare(undefined), 0.8); assert.equal(bufferShare(500), 0.1);
  assert.equal(loadLevel(400, 480, bufferShare(40)), "tight"); assert.equal(loadLevel(400, 480, bufferShare(10)), "ok");
  assert.equal(loadLevel(300, 480), "ok"); assert.equal(loadLevel(400, 480), "tight"); assert.equal(loadLevel(481, 480), "over"); assert.equal(loadLevel(0, 0), "ok"); assert.equal(loadLevel(30, 0), "over");
  assert.ok(isLeftover({ planned: "2026-11-09", week: "", status: "todo" }, "2026-11-10", "2026-11-09"));
  assert.ok(!isLeftover({ planned: "2026-11-10", week: "", status: "todo" }, "2026-11-10", "2026-11-09"));
  assert.ok(!isLeftover({ planned: "2026-11-09", week: "", status: "done" }, "2026-11-10", "2026-11-09"));
  assert.ok(isLeftover({ planned: "", week: "2026-11-02", status: "todo" }, "2026-11-10", "2026-11-09"));
  assert.ok(!isLeftover({ planned: "", week: "2026-11-09", status: "todo" }, "2026-11-10", "2026-11-09"));
  assert.ok(!isLeftover({ planned: "", week: "", status: "todo" }, "2026-11-10", "2026-11-09"));
}
{
  const { weekSteps } = await import("./.weekplan.mjs");
  assert.deepEqual(weekSteps(true, true), [0, 1, 2, 3, 4]); assert.deepEqual(weekSteps(false, true), [1, 2, 3, 4]);
  assert.deepEqual(weekSteps(false, false), [2, 3, 4]); assert.deepEqual(weekSteps(true, false), [0, 2, 3, 4]);
}
{
  const { weekVerdict, trimToBuffer } = await import("./.weekplan.mjs");
  assert.deepEqual(weekVerdict([{ planned: 100, free: 480 }, { planned: 0, free: 480 }]), { level: "ok", over: 0, tight: 0 });
  assert.deepEqual(weekVerdict([{ planned: 420, free: 480 }, { planned: 100, free: 480 }]), { level: "tight", over: 0, tight: 1 });
  assert.deepEqual(weekVerdict([{ planned: 500, free: 480 }, { planned: 420, free: 480 }]), { level: "over", over: 1, tight: 1 });
  assert.equal(trimToBuffer(500, 480), 116); assert.equal(trimToBuffer(300, 480), 0);
}
{
  const { upsertSection, removeSection, weekOverview, weekMeetings, taskLines, loadBar, loadNote, WEEK_ORDER } = await import("./.journal.mjs");
  let t = upsertSection("# Week\n", "Weekly review", "- r", WEEK_ORDER);
  t = upsertSection(t, "Planned tasks", "- t", WEEK_ORDER); t = upsertSection(t, "Meetings", "- m", WEEK_ORDER); t = upsertSection(t, "Overview", "- o", WEEK_ORDER);
  const at = h => t.indexOf("## " + h);
  assert.ok(at("Overview") < at("Meetings") && at("Meetings") < at("Planned tasks") && at("Planned tasks") < at("Weekly review") && t.includes("- r"));
  t = upsertSection(t, "Meetings", "- m2", WEEK_ORDER); assert.ok(t.includes("- m2") && !t.includes("- m\n") && t.includes("- t") && t.includes("- r"));
  assert.equal(removeSection("## A\n- 1\n## B\n- 2\n", "A"), "## B\n- 2\n"); assert.equal(removeSection("## A\n", "Z"), "## A\n");
  assert.equal(loadBar(300, 600), "█████░░░░░ 50%"); assert.equal(loadBar(0, 0), "–"); assert.equal(loadBar(10, 0), "██████████ over");
  assert.equal(loadNote(100, 600), ""); assert.equal(loadNote(500, 600), "past the 80% buffer"); assert.equal(loadNote(700, 600), "over capacity");
  const d = (h, m) => new Date(2026, 10, 9, h, m);
  const mon = { weekday: "Monday", label: "Monday", planned: 120, meetings: 60, free: 300, tasks: [{ title: "A", minutes: 120, subtasks: [], day: "Monday" }], events: [{ title: "Daily", start: d(9, 0), end: d(9, 30), allDay: false, note: "2026-11-09_daily" }] };
  const tue = { weekday: "Tuesday", label: "Tuesday", planned: 0, meetings: 0, free: 300, tasks: [], events: [] };
  assert.equal(weekMeetings([mon, tue]), "- **Monday**\n    - *09:00-09:30* [[2026-11-09_daily|Daily]]");
  assert.equal(weekMeetings([tue]), "- None");
  assert.equal(taskLines([{ title: "x", minutes: 20, subtasks: [], day: "no day" }, { title: "y", minutes: 45, subtasks: ["sub"], day: "Monday", time: "10:15-11:00" }, { title: "z", minutes: 180, subtasks: [], day: "Tuesday" }]),
    "- [[x]] \u2022 no day \u2022 *20 min*\n- [[y]] \u2022 Monday \u2022 *10:15-11:00* \u2022 *45 min*\n    - sub\n- [[z]] \u2022 Tuesday \u2022 *3 hr*");
  const ov = weekOverview([mon, tue], 2);
  assert.ok(ov.includes("| Monday | 2 hr (1) | 1 hr | 3 hr | ████░░░░░░ 40% |") && ov.includes("| Tuesday | – | – | 5 hr | ░░░░░░░░░░ 0% |") && ov.includes("3 tasks, 1 scheduled, 2 still without a day.") && !ov.includes("Recommended"));
  assert.ok(weekOverview([{ ...mon, note: "2026-11-09" }], 0).includes("| [[2026-11-09\\|Monday]] |"));
}

// ---- day review
await bundle("src/dayreview.ts", "test/.dayreview.mjs");
{
  const { runMinutesOn, taskRows, groupRows, daySplit, verdict } = await import("./.dayreview.mjs");
  assert.equal(runMinutesOn(["2026-11-11 09:05–09:40", "2026-11-11 10:00-10:30", "2026-11-10 09:00–10:00", "2026-11-11 23:30–2026-11-12 00:20", "junk"], "2026-11-11"), 35 + 30 + 30);
  const items = [
    { title: "A", wasPlanned: true, planned: 60, actual: 90, done: true, ticket: "T-1", project: "" },
    { title: "B", wasPlanned: true, planned: 30, actual: 0, done: false, ticket: "", project: "" },
    { title: "C", wasPlanned: false, planned: 0, actual: 20, done: false, ticket: "T-1", project: "" },
  ];
  assert.deepEqual(taskRows(items).map(r => [r.label, r.unplanned]), [["A", false], ["B", false], ["C", true]]);
  assert.deepEqual(groupRows(items, "ticket").map(g => [g.label, g.planned, g.actual]), [["T-1", 60, 110], ["No ticket", 30, 0]]);
  assert.deepEqual(taskRows([...items, { title: "D", wasPlanned: false, planned: 0, actual: 0, done: true, ticket: "", project: "" }]).map(r => r.label).includes("D"), true);
  const sp = daySplit(120, 100, 40, 15); assert.equal(sp.focus, 80); assert.equal(sp.other, 0); assert.equal(sp.total, 135);
  assert.equal(verdict(60, 62, 1, 1).title, "Right on plan"); assert.equal(verdict(60, 90, 1, 1).title, "More than planned");
}

// ---- meeting series
await bundle("src/meetingseries.ts", "test/.meetingseries.mjs");
{
  const { nextWorkday, buildSeries, cadenceOf, analyse, parseNote, seriesKey, stripFrontmatter } = await import("./.meetingseries.mjs");
  assert.deepEqual(["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"].map(nextWorkday), ["2026-11-13", "2026-11-16", "2026-11-16", "2026-11-16"]);
  assert.equal(seriesKey("  AI Next  Daily "), "ai next daily");
  assert.deepEqual(cadenceOf(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"]), { label: "Daily", days: "Mon–Fri" });
  assert.deepEqual(cadenceOf(["2026-11-03", "2026-11-10", "2026-11-17"]), { label: "Weekly", days: "Tue" });
  assert.deepEqual(cadenceOf(["2026-11-06", "2026-11-20"]), { label: "Every 2 weeks", days: "Fri" });
  assert.deepEqual(cadenceOf(["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12"]), { label: "2× a week", days: "Mon, Thu" });
  assert.deepEqual(analyse("# T\n\n## Meeting Summary\n\n"), { excerpt: [], open: 0, done: 0 });
  assert.deepEqual(analyse("## S\n- Decided X\n- [ ] Send mail\n- [x] Book room\n- [ ]\n"), { excerpt: ["Decided X", "Send mail", "Book room"], open: 1, done: 1 });
  assert.equal(stripFrontmatter("---\na: 1\n---\n# H\n"), "# H\n");
  const mk = (title, date, rec, body = "") => parseNote("p/" + date + title, { title, date, start: "09:00", end: "09:30", ...(rec === undefined ? {} : { is_recurring: rec }) }, date + "_x", "---\n---\n" + body);
  const { series, oneOffs } = buildSeries([mk("Daily ", "2026-11-10", true, "- done"), mk("Daily", "2026-11-12", true), mk("Daily", "2026-11-13", true), mk("Offsite", "2026-11-11", false), mk("Offsite", "2026-11-18", false)], "2026-11-12");
  assert.equal(series.length, 1); assert.equal(oneOffs.length, 2);
  assert.deepEqual([series[0].held, series[0].withNotes, series[0].next.date, series[0].next.when, series[0].time], [1, 1, "2026-11-12", "today", "09:00–09:30"]);
  { const r = buildSeries([mk("Daily", "2026-11-12", true)], "2026-11-12", 9 * 60 + 30).series[0]; assert.deepEqual([r.instances[0].when, r.held, r.next], ["past", 1, undefined]); } // today, time frame over
  { const r = buildSeries([mk("Daily", "2026-11-12", true)], "2026-11-12", 9 * 60 + 29).series[0]; assert.deepEqual([r.instances[0].when, r.held], ["today", 0]); }
  assert.equal(buildSeries([mk("A", "2026-11-01"), mk("A", "2026-11-08"), mk("B", "2026-11-02")], "2026-11-12").series.length, 1); // no property: repeats count as a series
}
