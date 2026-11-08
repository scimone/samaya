import esbuild from "esbuild";
import assert from "node:assert/strict";
const bundle = async (entry, out) => esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, alias: { obsidian: "./test/obsidian-stub.mjs" }, logLevel: "error" });
await bundle("src/home.ts", "test/.home.mjs"); await bundle("src/ics.ts", "test/.ics.mjs"); await bundle("src/util.ts", "test/.util.mjs");
await bundle("src/worktime.ts", "test/.worktime.mjs");
await bundle("src/taskbody.ts", "test/.taskbody.mjs"); await bundle("src/timeline.ts", "test/.timeline.mjs");
await bundle("src/settings.ts", "test/.settings.mjs");
await bundle("src/monthgrid.ts", "test/.monthgrid.mjs"); await bundle("src/kanban.ts", "test/.kanban.mjs"); await bundle("src/gantt.ts", "test/.gantt.mjs"); await bundle("src/journal.ts", "test/.journal.mjs"); await bundle("src/tickets.ts", "test/.tickets.mjs");
const { parseIcs } = await import("./.ics.mjs");
const { parseTitleEstimate, startOfWeek, addDays, fmtDur, fmtHm, parseDuration, slugify } = await import("./.util.mjs");
const { latestOnOrBefore, neighbours } = await import("./.journal.mjs");
const { fmtEstimate, taskLines, bulletLines, upsertSection, readSection, pickJournalSource: pick } = await import("./.journal.mjs");
const { fetchJira, fetchGitlab, adfToText } = await import("./.tickets.mjs");
const { renderTicketPath, renderTicketFileName, renderTicketNote, pathRoot: pathRoot2 } = await import("./.taskbody.mjs");

// ---- ics
const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Standup\\, daily
DTSTART:20261102T090000
DTEND:20261102T091500
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
BEGIN:VEVENT
SUMMARY:Holiday
DTSTART;VALUE=DATE:20261103
DTEND;VALUE=DATE:20261104
END:VEVENT
BEGIN:VEVENT
SUMMARY:Weekly
DTSTART:20261102T140000
DTEND:20261102T150000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE:20261104T140000
END:VEVENT
END:VCALENDAR`;
const ev = parseIcs(ics, new Date(2026, 10, 1), new Date(2026, 10, 8));
const names = ev.map(e => e.title + "@" + e.start.getDate());
assert.deepEqual(names.filter(n => n.startsWith("Standup")), ["Standup, daily@2", "Standup, daily@3", "Standup, daily@4"]);
assert.ok(ev.find(e => e.title === "Holiday" && e.allDay));
assert.deepEqual(names.filter(n => n.startsWith("Weekly")), ["Weekly@2"]);

// ---- util
assert.deepEqual(parseTitleEstimate("Write report 1h"), { title: "Write report", estimate: 60 });
assert.deepEqual(parseTitleEstimate("Call mom"), { title: "Call mom" });
assert.equal(startOfWeek("2026-11-03"), "2026-11-02");
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

// ---- worktime
const W = await import("./.worktime.mjs");
const log = { date: "2026-11-03", start: "08:30", end: "17:00", breaks: [{ start: "12:00", end: "12:45", kind: "lunch" }, { start: "15:00", end: "15:10", kind: "break" }], open: null };
assert.equal(W.workedMinutes(log, 0), 8 * 60 + 30 - 55);
assert.equal(W.workedMinutes({ date: "d", start: "09:00", end: null, breaks: [], open: { start: "10:00", kind: "break" } }, 10 * 60 + 20), 60); // open break not counted
assert.deepEqual(W.parseBreak("12:00-12:45 lunch"), { start: "12:00", end: "12:45", kind: "lunch" });
assert.equal(W.fmtBreak({ start: "15:00", end: "15:10", kind: "break" }), "15:00-15:10");
assert.equal(W.parseBreak("nope"), null);
assert.equal(W.dailyTarget(40, 5, "2026-11-03"), 480); assert.equal(W.dailyTarget(40, 5, "2026-11-07"), 0); assert.equal(W.dailyTarget(30, 4, "2026-11-06"), 0);
assert.equal(W.unionMinutes([[0, 60], [30, 90], [120, 150]]), 120);
const cap = W.capacityMinutes(6, [720, 780], [[600, 660], [630, 690], [740, 800]]); // meetings: 10:00-11:30 (union 90) + 12:20-13:20 -> 20 min beyond lunch end
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
assert.equal(bulletLines(["", "- a", "b "]), "- a\n- b");
let note = upsertSection("", "Planned today", "- [[A]]");
note = upsertSection(note, "Planned for tomorrow", "- [[C]]");
note = upsertSection(note, "Finished today", "- [[A]] • *5 min*"); // must land before "Planned for tomorrow"
const order = note.split("\n").filter(l => l.startsWith("## "));
assert.deepEqual(order, ["## Planned today", "## Finished today", "## Planned for tomorrow"]);
note = upsertSection(note, "Planned today", "- [[A]]\n- [[B]]"); // replaces, doesn't duplicate
assert.equal(note.split("## Planned today").length, 2);
assert.deepEqual(readSection(note, "Planned today"), ["[[A]]", "[[B]]"]);
assert.ok(upsertSection("# My day\nfree text\n", "Planned today", "- x").startsWith("# My day\nfree text"));

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
  const m = migrateSettings({ jiraUrl: "https://x.atlassian.net", jiraToken: "t", gitlabToken: "", icsUrls: ["https://c/ics"] });
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

// ---- home
const { pickMoment, greeting, weekIntent, inMinutes } = await import("./.home.mjs");
const mi = { started: true, ended: false, onBreak: false, now: 600, shutdown: 1050, open: 2, total: 4 };
assert.equal(pickMoment({ ...mi, started: false }), "morning");
assert.equal(pickMoment(mi), "working");
assert.equal(pickMoment({ ...mi, onBreak: true }), "break");
assert.equal(pickMoment({ ...mi, now: 1050 }), "wrapup");
assert.equal(pickMoment({ ...mi, open: 0 }), "wrapup");
assert.equal(pickMoment({ ...mi, open: 0, total: 0 }), "working");
assert.equal(pickMoment({ ...mi, ended: true }), "done");
assert.equal(greeting(8), "Good morning"); assert.equal(greeting(13), "Good afternoon"); assert.equal(greeting(20), "Good evening");
assert.equal(weekIntent(1, 9), "plan"); assert.equal(weekIntent(3, 9), null); assert.equal(weekIntent(5, 10), null); assert.equal(weekIntent(5, 15), "review"); assert.equal(weekIntent(0, 12), "plan");
assert.equal(inMinutes(0), "now"); assert.equal(inMinutes(25), "in 25m"); assert.equal(inMinutes(65), "in 1h 5m"); assert.equal(inMinutes(120), "in 2h");
console.log("home ok");
