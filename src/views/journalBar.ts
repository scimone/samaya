import { Menu, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import { ConfirmCreateModal, ConfirmCreatePeriodModal } from "../modals";
import type SamayaPlugin from "../main";
import { PERIODIC_KINDS, PERIOD_UI, Period, listPeriodNotes, openPeriodNote, periodNotePath } from "../journal";
import { anchor, nearestSpan, retarget, spanStart, weekValue, weekValueDate } from "../journaldigest";
import { parseYmd, startOfWeek, today } from "../util";
import { renderDateNav, renderResetPill } from "./dateNav";
import { openPeriodPicker } from "./periodPicker";
import { isoWeek, renderHeadTitle, weekRangeLabel } from "./plannerHead";

const month = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, o);

/** The bar's title over its muted line, written like the planner's headings: "Thursday" over "Nov 12, 2026 · Week 46", "Week 46" over its dates, "November" over "2026". */
export function journalBarTitle(p: Period, date: string): { title: string; sub: string } {
  const a = anchor(p, date); const d = parseYmd(a);
  switch (p) {
    case "daily": return { title: month(d, { weekday: "long" }), sub: `${month(d, { month: "short", day: "numeric", year: "numeric" })} · Week ${isoWeek(d)}` };
    case "weekly": return { title: `Week ${isoWeek(d)}`, sub: weekRangeLabel(startOfWeek(a)) };
    case "monthly": return { title: month(d, { month: "long" }), sub: String(d.getFullYear()) };
    case "quarterly": { const q = Math.floor(d.getMonth() / 3); const m = (i: number) => month(new Date(d.getFullYear(), q * 3 + i, 1), { month: "short" }); return { title: `Q${q + 1}`, sub: `${m(0)} – ${m(2)} ${d.getFullYear()}` }; }
    case "yearly": return { title: String(d.getFullYear()), sub: " " };
  }
}

/** Open the note of the span containing `date` in this tab; a missing one is only created after the user agrees. */
async function go(plugin: SamayaPlugin, leaf: WorkspaceLeaf, p: Period, date: string) {
  const s = plugin.settings; const info = await periodNotePath(plugin.app, s, p, date); if (!info) return;
  const open = (f: TFile | null) => { if (f) void leaf.openFile(f); };
  if (info.file) open(info.file);
  else new ConfirmCreateModal(plugin, info.path, () => { void openPeriodNote(plugin.app, s, p, date).then(open); }, `A new ${PERIOD_UI[p].noun} note.`).open();
}

const KIND: Record<Period, string> = { daily: "Day", weekly: "Week", monthly: "Month", quarterly: "Quarter", yearly: "Year" };
const ADJ: Record<Period, string> = { daily: "daily", weekly: "weekly", monthly: "monthly", quarterly: "quarterly", yearly: "yearly" };

/** Show the note of another kind for the same time: the note that contains the date (see `retarget`), else the closest one that exists, and only when there is no note of that kind at all, a question whether to create it. */
async function switchKind(plugin: SamayaPlugin, leaf: WorkspaceLeaf, from: Period, date: string, to: Period) {
  const s = plugin.settings; const ref = spanStart(to, retarget(from, date, to, today()));
  const info = await periodNotePath(plugin.app, s, to, ref); if (!info) return;
  if (info.file) { void leaf.openFile(info.file); return; }
  const near = nearestSpan(to, await listPeriodNotes(plugin.app, s, to), ref); if (near) { void leaf.openFile(near.file); return; }
  const t = journalBarTitle(to, ref); const label = to === "yearly" ? t.title : to === "daily" ? `${t.title}, ${t.sub}` : `${t.title} (${t.sub})`; // "Friday, Nov 13, 2026 · Week 46", "Week 46 (Nov 9 – 15)", "Q4 (Oct – Dec 2026)", "2026"
  new ConfirmCreatePeriodModal(plugin, ADJ[to], label, () => { void openPeriodNote(plugin.app, s, to, ref).then(f => { if (f) void leaf.openFile(f); }); }).open();
}

/** The bar above a journal note, built like the planner's heading: title and dates on the left, on the right the pill back to now (only when elsewhere), then ‹ 📅 › (arrows step to the previous / next note that exists, the calendar picks any date). */
export function renderJournalBar(plugin: SamayaPlugin, leaf: WorkspaceLeaf, bar: HTMLElement, cur: { p: Period; date: string }, prev: TFile | null, next: TFile | null, isNow: boolean) {
  const ui = PERIOD_UI[cur.p]; const t = journalBarTitle(cur.p, cur.date);
  renderHeadTitle(bar, t.title, t.sub).addClass("is-inline"); // the dates sit next to the title: a slimmer bar
  const right = bar.createDiv("samaya-planner-right");
  if (cur.p === "daily" || cur.p === "weekly") { // the planner of this day / week
    const b = right.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": "Open Samaya" } }); setIcon(b, "calendar-clock");
    b.onclick = () => { void plugin.openPlannerAt(cur.p === "daily" ? "day" : "week", anchor(cur.p, cur.date)); };
  }
  const s = plugin.settings; const kinds: Period[] = ["daily", ...PERIODIC_KINDS.filter(k => s.journalNotes[k].on)];
  const kind = right.createEl("button", { cls: `samaya-jn-badge samaya-jb-kind is-${cur.p}`, attr: { "aria-label": kinds.length > 1 ? "Switch to another kind of note" : KIND[cur.p] } });
  kind.createSpan({ text: KIND[cur.p] });
  if (kinds.length > 1) {
    setIcon(kind.createSpan("samaya-jb-kind-caret"), "chevron-down");
    kind.onclick = () => {
      const menu = new Menu();
      for (const k of kinds) menu.addItem(i => i.setTitle(KIND[k]).setChecked(k === cur.p).onClick(() => { if (k !== cur.p) void switchKind(plugin, leaf, cur.p, cur.date, k); }));
      const r = kind.getBoundingClientRect(); menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
    };
  }
  if (!isNow) renderResetPill(right, ui.now, `Go to ${ui.now.toLowerCase()}`, cur.date < today() ? "right" : "left", () => { void go(plugin, leaf, cur.p, today()); });
  renderDateNav(right, {
    label: t.title, prevLabel: `Previous ${ui.noun}`, nextLabel: `Next ${ui.noun}`,
    onPrev: () => { if (prev) void leaf.openFile(prev); }, onNext: () => { if (next) void leaf.openFile(next); },
    prevDisabled: !prev, nextDisabled: !next,
    pick: pickerFor(plugin, leaf, cur),
    icon: "calendar",
  });
}

/** The date picker fitted to the kind of note: a day calendar, a week picker, the months of a year, the quarters of a year, or a page of years. */
function pickerFor(plugin: SamayaPlugin, leaf: WorkspaceLeaf, cur: { p: Period; date: string }) {
  const p = cur.p; const a = anchor(p, cur.date); const to = (d: string) => { void go(plugin, leaf, p, d); };
  if (p === "weekly") return { value: weekValue(a), type: "week" as const, label: "Pick a week", run: (v: string) => to(weekValueDate(v)) };
  if (p === "monthly" || p === "quarterly" || p === "yearly") return { value: a, label: p === "monthly" ? "Pick a month" : p === "quarterly" ? "Pick a quarter" : "Pick a year", run: to, open: (el: HTMLElement) => openPeriodPicker(el, p, a, to) };
  return { value: a, label: "Pick a date", run: to };
}
