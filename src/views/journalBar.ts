import type { TFile, WorkspaceLeaf } from "obsidian";
import { ConfirmCreateModal } from "../modals";
import type SamayaPlugin from "../main";
import { PERIOD_UI, Period, openPeriodNote, periodNotePath } from "../journal";
import { anchor } from "../journaldigest";
import { parseYmd, startOfWeek, today } from "../util";
import { renderDateNav, renderResetPill } from "./dateNav";
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

/** The bar above a journal note, built like the planner's heading: title and dates on the left, on the right the pill back to now (only when elsewhere), then ‹ 📅 › (arrows step to the previous / next note that exists, the calendar picks any date). */
export function renderJournalBar(plugin: SamayaPlugin, leaf: WorkspaceLeaf, bar: HTMLElement, cur: { p: Period; date: string }, prev: TFile | null, next: TFile | null, isNow: boolean) {
  const ui = PERIOD_UI[cur.p]; const t = journalBarTitle(cur.p, cur.date);
  renderHeadTitle(bar, t.title, t.sub);
  const right = bar.createDiv("samaya-planner-right");
  if (!isNow) renderResetPill(right, ui.now, `Go to ${ui.now.toLowerCase()}`, cur.date < today() ? "right" : "left", () => { void go(plugin, leaf, cur.p, today()); });
  renderDateNav(right, {
    label: t.title, prevLabel: `Previous ${ui.noun}`, nextLabel: `Next ${ui.noun}`,
    onPrev: () => { if (prev) void leaf.openFile(prev); }, onNext: () => { if (next) void leaf.openFile(next); },
    prevDisabled: !prev, nextDisabled: !next,
    pick: { value: cur.date, label: "Pick a date", run: d => { void go(plugin, leaf, cur.p, d); } }, icon: "calendar",
  });
}
