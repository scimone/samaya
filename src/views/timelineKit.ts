import { TFile, setIcon } from "obsidian";
import type { CalendarEvent } from "../eventnotes";
import type SamayaPlugin from "../main";
import type { DndScope } from "../dnd";
import { Task, setDone } from "../model";
import { layoutItems } from "../timeline";
import { minToHm, parseYmd, today } from "../util";
import { PartsModal } from "./partsModal";
import { canSplit, keyActivate, showTaskMenu } from "./common";
import { renderDayLines } from "./dayLines";
import { decorateSegment, dragLen, dropOnTimeline, remainingBlocks, resizeBlock, segLabel } from "./place";
import { addBands } from "./bands";

const MIN_HOUR_H = 28;

/** Scroll memory of a timeline, kept by its owner across re-renders. */
export interface TimelineState { scrolled: string; scrollTop: number; }

/** The draggable day timeline (hours, meetings, task blocks). Fills `c`; returns the height it was laid out for. */
export function renderTimeline(plugin: SamayaPlugin, dnd: DndScope, c: HTMLElement, o: { date: string; day: Task[]; events: CalendarEvent[]; notes: Map<CalendarEvent, TFile>; ro: boolean; /** scissors on the blocks */ split?: boolean; /** do not light up the task being worked on right now (End my day) */ noCurrent?: boolean; state: TimelineState }): number {
  const { date, day, events, notes, ro, state } = o;
  {
    const s = plugin.settings; const dayMs = parseYmd(date).getTime(); const isToday = date === today();
    const startH = s.dayStartHour, endH = s.dayEndHour, slot = s.slotMinutes; const dayStartMs = dayMs;
    const scroll = c.createDiv("samaya-scroll");
    // stretch the hours so the day fills the whole sidebar height
    const seenH = c.clientHeight;
    const HOUR_H = Math.max(MIN_HOUR_H, Math.floor((scroll.clientHeight - 12) / (endH - startH)));
    const grid = scroll.createDiv("samaya-grid"); grid.style.height = `${(endH - startH) * HOUR_H}px`;
    for (let h = startH; h < endH; h++) {
      const row = grid.createDiv("samaya-hour"); row.style.top = `${(h - startH) * HOUR_H}px`; row.style.height = `${HOUR_H}px`;
      row.createSpan({ cls: "samaya-hour-label", text: minToHm(h * 60) });
      row.createDiv("samaya-hour-half");
    }
    const lane = grid.createDiv("samaya-lane");
    addBands(plugin, lane, date, startH, endH, HOUR_H, date);
    const px = (m: number) => ((m - startH * 60) / 60) * HOUR_H;
    const snap = (y: number) => Math.round((y / HOUR_H * 60 + startH * 60) / slot) * slot;
    const startFor = (i: { y: number; grabY: number }, dur: number) => {
      const m = snap(i.y - lane.getBoundingClientRect().top - i.grabY);
      return Math.max(startH * 60, Math.min(endH * 60 - Math.min(dur, slot), m));
    };

    let preview: HTMLElement | null = null;
    if (!ro) { // drop target: give a task a time slot
    // target = the visible scroll box (the lane itself extends beyond it when scrolled)
    dnd.target(scroll, {
      over: i => {
        const dur = dragLen(plugin, i.path, i.seg, i.day, date); const m = startFor(i, dur);
        if (!preview) preview = lane.createDiv("samaya-preview");
        preview.style.top = `${px(m)}px`; preview.style.height = `${Math.max(20, (dur / 60) * HOUR_H - 2)}px`;
        preview.setText(`${minToHm(m)} – ${minToHm(m + dur)}`);
      },
      leave: () => { preview?.remove(); preview = null; },
      drop: i => {
        preview?.remove(); preview = null;
        const f = plugin.app.vault.getAbstractFileByPath(i.path); if (!(f instanceof TFile)) return;
        const dur = dragLen(plugin, i.path, i.seg, i.day, date);
        void dropOnTimeline(plugin, f, date, startFor(i, dur), i.seg, i.day, events, endH * 60, slot);
      },
    });

    }

    interface Item { s: number; dur: number; task?: Task; ev?: CalendarEvent; seg?: number; n?: number; cut?: number; }
    const items: Item[] = [];
    events.filter(e => !e.allDay).forEach(e => {
      const sm = Math.max(0, (e.start.getTime() - dayStartMs) / 60000), em = Math.min(1440, (e.end.getTime() - dayStartMs) / 60000);
      if (em > startH * 60 && sm < endH * 60) items.push({ s: sm, dur: Math.max(15, em - sm), ev: e });
    });
    day.filter(t => t.start).forEach(t => { const { blocks: bl, cut } = remainingBlocks(plugin, t, date, s.defaultEstimate); bl.forEach((g, k) => items.push({ s: g.s, dur: g.dur, task: t, seg: k, n: bl.length, cut: k === 0 ? cut : 0 })); });
    items.sort((a, b) => a.s - b.s || b.dur - a.dur);
    const slots = layoutItems(items);
    const open = (f: TFile) => { void plugin.app.workspace.getLeaf("tab").openFile(f); };
    const nowD = new Date(); const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
    items.forEach(it => {
      if (it.s + it.dur <= startH * 60 || it.s >= endH * 60) return;
      const pl = slots.get(it)!; const top = px(Math.max(it.s, startH * 60));
      const height = Math.max(22, px(Math.min(it.s + it.dur, endH * 60)) - top - 2);
      const b = lane.createDiv({ cls: it.ev ? "samaya-event" : "samaya-block" + (it.task!.status === "done" ? " is-done" : "") });
      if (it.task) { b.dataset.link = it.task.file.path; b.dataset.day = date; }
      b.style.top = `${top}px`; b.style.height = `${height}px`; b.style.left = `${(pl.col * 100) / pl.n}%`; b.style.width = `calc(${100 / pl.n}% - 3px)`;
      if (isToday && !o.noCurrent && nowMin >= it.s && nowMin < it.s + it.dur && it.task?.status !== "done") b.addClass("is-current");
      if (it.ev && (date < today() || (isToday && nowMin >= it.s + it.dur))) b.addClass("is-past"); // a meeting that is over
      const bt = b.createDiv({ cls: it.ev ? "samaya-event-title" : "samaya-block-title" });
      if (!it.ev) {
        const task = it.task!;
        const st = bt.createSpan({ cls: "samaya-block-state", attr: { title: task.status === "done" ? "Mark as not done" : "Mark as done" } });
        const toggle = () => { void setDone(plugin.app, task, task.status !== "done"); };
        st.addEventListener("click", e => { e.stopPropagation(); toggle(); });
        keyActivate(st, `Done: ${task.title}`, toggle, "checkbox"); st.setAttr("aria-checked", String(task.status === "done"));
      }
      bt.createSpan({ text: it.ev ? it.ev.title : it.task!.title });
      const when = `${minToHm(it.s)} – ${minToHm(it.s + it.dur)}`;
      b.createDiv({ cls: it.ev ? "samaya-event-time" : "samaya-block-time", text: `${when}${it.ev ? "" : segLabel(it.seg!, it.n!)}` });
      if (it.ev) { const n = notes.get(it.ev); if (n) { b.title = "Open meeting note"; b.addEventListener("click", () => open(n)); keyActivate(b, `Meeting: ${it.ev.title}, ${when}. Open note`, () => open(n)); } return; }
      const t = it.task!;
      keyActivate(b, `Task: ${t.title}, ${when}. Press Enter to open`, () => open(t.file));
      decorateSegment(b, t, it.seg!, it.n!, lane);
      b.addEventListener("dblclick", () => open(t.file));
      b.addEventListener("contextmenu", e => showTaskMenu(plugin, t, e, it.n! > 1 ? it.seg! : null, !!o.split));
      if (ro) return; // read-only while reviewing and picking
      if (o.split && canSplit(t)) { // scissors on hover: cut this block into parts
        const cut = b.createEl("button", { cls: "samaya-block-split", attr: { "aria-label": "Split into parts" } });
        setIcon(cut, "scissors"); cut.addEventListener("pointerdown", e => e.stopPropagation());
        cut.addEventListener("click", e => { e.stopPropagation(); new PartsModal(plugin, t, "split", it.n! > 1 ? it.seg! : null).open(); });
      }
      dnd.draggable(b, t.file.path);
      const handle = b.createDiv("samaya-resize");
      handle.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        const startY = e.clientY; const dur0 = it.dur; let nd = dur0;
        const move = (ev: PointerEvent) => {
          nd = Math.max(slot, Math.round((dur0 + ((ev.clientY - startY) / HOUR_H) * 60) / slot) * slot);
          b.style.height = `${Math.max(22, (nd / 60) * HOUR_H - 2)}px`;
        };
        const up = () => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
          if (nd !== dur0) void resizeBlock(plugin, t, it.seg!, nd + (it.cut ?? 0));
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      });
    });

    renderDayLines(plugin, date, lane, grid, { startH, endH, slot }, HOUR_H, px);
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    if (isToday && nm >= startH * 60 && nm <= endH * 60) lane.createDiv("samaya-now").style.top = `${px(nm)}px`;
    if (state.scrolled !== date) { state.scrolled = date; state.scrollTop = Math.max(0, px(nm) - 120); }
    scroll.scrollTop = state.scrollTop;
    return seenH;
  }
}
