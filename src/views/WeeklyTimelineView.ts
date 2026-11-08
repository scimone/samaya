import { BasesView, QueryController, TFile } from "obsidian";
import type SamayaPlugin from "../main";
import { DndScope } from "../dnd";
import { Task, patchTask, readTask, setDone, sortTasks } from "../model";
import { addDays, fmtDur, hmToMin, minToHm, parseYmd, startOfWeek, today } from "../util";
import type { IcsEvent } from "../ics";
import { calendarEnabled, calendarEvents, inEventFolder } from "../calendar";
import { layoutItems } from "../timeline";
import { addBands } from "./bands";

export const WTL_VIEW_TYPE = "samaya-week-timeline";
const MIN_HOUR_H = 40;

/** The calendar of one week: a column per day with meetings and the tasks that have a time slot. */
export class WeeklyTimelineView extends BasesView {
  readonly type = WTL_VIEW_TYPE;
  private root: HTMLElement;
  private weekStart = startOfWeek(today());
  private scope = new DndScope();
  private pending = false;
  private timer = 0;
  private token = 0;
  private scrollTop = 0;
  private scrolledFor = "";
  private hourH = MIN_HOUR_H;
  private seenH = 0;

  constructor(controller: QueryController, parentEl: HTMLElement, private plugin: SamayaPlugin) {
    super(controller);
    this.root = parentEl.createDiv("samaya-wtl");
    this.scope.onIdle = () => { if (this.pending) { this.pending = false; this.schedule(); } };
    const ro = new ResizeObserver(() => { if (this.root.clientHeight !== this.seenH) this.schedule(); });
    ro.observe(this.root); this.register(() => ro.disconnect());
    this.registerInterval(window.setInterval(() => this.updateNowLines(), 60000));
    this.register(plugin.bus.on(() => this.schedule()));
    const ref = plugin.app.metadataCache.on("changed", f => { if (inEventFolder(plugin.settings, f.path)) this.schedule(); });
    this.register(() => plugin.app.metadataCache.offref(ref));
  }
  onunload() { window.clearTimeout(this.timer); this.scope.dispose(); }
  onDataUpdated(): void { this.schedule(); }
  private schedule() {
    if (this.scope.active) { this.pending = true; return; }
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.render(); }, 30);
  }

  private opt(k: string, d: number) { const raw = this.config.get(k); return raw == null || raw === "" || isNaN(Number(raw)) ? d : Number(raw); }

  private async render() {
    const token = ++this.token; const s = this.plugin.settings;
    const startH = this.opt("dayStart", s.dayStartHour), endH = Math.max(startH + 1, this.opt("dayEnd", s.dayEndHour)), slot = s.slotMinutes;
    const days = this.config.get("showWeekends") === true ? 7 : 5;
    const events = this.config.get("showIcs") !== false && calendarEnabled(s)
      ? (await calendarEvents(this.plugin, parseYmd(this.weekStart), parseYmd(addDays(this.weekStart, 7))).catch(() => [] as IcsEvent[])) : [];
    if (token !== this.token) return;
    if (this.scope.active) { this.pending = true; return; }

    const old = this.root.querySelector<HTMLElement>(".samaya-wtl-scroll"); if (old) this.scrollTop = old.scrollTop;
    this.root.empty(); this.scope.clear();
    const all = this.data.data.map(e => readTask(this.app, e.file));
    const byPath = new Map(all.map(t => [t.file.path, t]));

    const head = this.root.createDiv("samaya-week-head");
    const go = (w: string) => { this.weekStart = w; this.scrolledFor = ""; void this.render(); };
    head.createEl("button", { text: "‹" }).onclick = () => go(addDays(this.weekStart, -7));
    head.createEl("button", { text: "This week" }).onclick = () => go(startOfWeek(today()));
    head.createEl("button", { text: "›" }).onclick = () => go(addDays(this.weekStart, 7));
    const fmt = (x: string) => parseYmd(x).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    head.createEl("h2", { text: `${fmt(this.weekStart)} – ${fmt(addDays(this.weekStart, 6))}` });

    const scroll = this.root.createDiv("samaya-wtl-scroll");
    const cols = scroll.createDiv("samaya-wtl-heads");
    cols.createDiv("samaya-wtl-axis-spacer");
    // stretch the hours so the day fills the available height
    this.seenH = this.root.clientHeight;
    const HOUR_H = this.hourH = Math.max(MIN_HOUR_H, Math.floor((scroll.clientHeight - 70) / (endH - startH)));
    const body = scroll.createDiv("samaya-wtl-body");
    const axis = body.createDiv("samaya-wtl-axis"); axis.style.height = `${(endH - startH) * HOUR_H}px`;
    for (let h = startH; h < endH; h++) axis.createSpan({ cls: "samaya-wtl-hour-label", text: minToHm(h * 60) }).style.top = `${(h - startH) * HOUR_H}px`;
    const px = (m: number) => ((m - startH * 60) / 60) * HOUR_H;
    const open = (f: TFile) => { void this.app.workspace.getLeaf("tab").openFile(f); };

    for (let i = 0; i < days; i++) {
      const date = addDays(this.weekStart, i); const dayMs = parseYmd(date).getTime(); const isToday = date === today();
      const dayEvents = events.filter(e => e.end.getTime() > dayMs && e.start.getTime() < dayMs + 86400000);
      const dayTasks = sortTasks(all.filter(t => t.planned === date));

      // header: weekday, all-day events, tasks without a time slot
      const h = cols.createDiv("samaya-wtl-head" + (isToday ? " is-today" : ""));
      h.createDiv({ cls: "samaya-wtl-day", text: parseYmd(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) });
      dayEvents.filter(e => e.allDay).forEach(e => h.createDiv({ cls: "samaya-wtl-chip is-event", text: e.title }));
      dayTasks.filter(t => !t.start && t.status !== "done").forEach(t => {
        const c = h.createDiv({ cls: "samaya-wtl-chip", attr: { title: "No time slot yet - drag onto the calendar" } });
        c.createSpan({ cls: "samaya-wtl-chip-title", text: t.title });
        c.createSpan({ cls: "samaya-wtl-chip-est", text: fmtDur(t.estimate || s.defaultEstimate) });
        c.addEventListener("dblclick", () => open(t.file)); this.scope.draggable(c, t.file.path);
      });

      const col = body.createDiv("samaya-wtl-col" + (isToday ? " is-today" : "")); col.style.height = `${(endH - startH) * HOUR_H}px`;
      for (let hr = startH; hr < endH; hr++) col.createDiv("samaya-wtl-hour").style.top = `${(hr - startH) * HOUR_H}px`;
      const lane = col.createDiv("samaya-lane");
      addBands(this.plugin, lane, date, startH, endH, HOUR_H, today());

      const startFor = (i2: { y: number; grabY: number }, dur: number) => {
        const m = Math.round((((i2.y - lane.getBoundingClientRect().top - i2.grabY) / HOUR_H) * 60 + startH * 60) / slot) * slot;
        return Math.max(startH * 60, Math.min(endH * 60 - Math.min(dur, slot), m));
      };
      let preview: HTMLElement | null = null;
      this.scope.target(lane, {
        over: i2 => {
          const dur = byPath.get(i2.path)?.estimate || s.defaultEstimate; const m = startFor(i2, dur);
          if (!preview) preview = lane.createDiv("samaya-preview");
          preview.style.top = `${px(m)}px`; preview.style.height = `${Math.max(18, (dur / 60) * HOUR_H - 2)}px`;
          preview.setText(`${minToHm(m)} – ${minToHm(m + dur)}`);
        },
        leave: () => { preview?.remove(); preview = null; },
        drop: i2 => {
          preview?.remove(); preview = null;
          const f = this.app.vault.getAbstractFileByPath(i2.path); if (!(f instanceof TFile)) return;
          const dur = readTask(this.app, f).estimate || s.defaultEstimate;
          void patchTask(this.app, f, { planned: date, week: null, start: minToHm(startFor(i2, dur)), estimate: dur });
        },
      });

      interface Item { s: number; dur: number; task?: Task; ev?: IcsEvent; }
      const items: Item[] = [];
      dayEvents.filter(e => !e.allDay).forEach(e => {
        const sm = Math.max(0, (e.start.getTime() - dayMs) / 60000), em = Math.min(1440, (e.end.getTime() - dayMs) / 60000);
        if (em > startH * 60 && sm < endH * 60) items.push({ s: sm, dur: Math.max(15, em - sm), ev: e });
      });
      dayTasks.filter(t => t.start).forEach(t => items.push({ s: hmToMin(t.start), dur: t.estimate || s.defaultEstimate, task: t }));
      items.sort((a, b) => a.s - b.s || b.dur - a.dur);
      const slots = layoutItems(items);
      items.forEach(it => {
        if (it.s + it.dur <= startH * 60 || it.s >= endH * 60) return;
        const pl = slots.get(it)!; const top = px(Math.max(it.s, startH * 60));
        const height = Math.max(18, px(Math.min(it.s + it.dur, endH * 60)) - top - 2);
        const b = lane.createDiv({ cls: it.ev ? "samaya-event" : "samaya-block" + (it.task!.status === "done" ? " is-done" : "") });
        b.style.top = `${top}px`; b.style.height = `${height}px`; b.style.left = `${(pl.col * 100) / pl.n}%`; b.style.width = `calc(${100 / pl.n}% - 2px)`;
        if (it.ev) {
          b.createDiv({ cls: "samaya-event-title", text: it.ev.title });
          b.createDiv({ cls: "samaya-event-time", text: `${minToHm(it.s)}–${minToHm(it.s + it.dur)}` });
          return;
        }
        const t = it.task!;
        const bt = b.createDiv("samaya-block-title");
        const st = bt.createSpan({ cls: "samaya-block-state", attr: { title: t.status === "done" ? "Mark as not done" : "Mark as done" } });
        st.addEventListener("click", e => { e.stopPropagation(); void setDone(this.app, t, t.status !== "done"); });
        bt.createSpan({ text: t.title });
        b.createDiv({ cls: "samaya-block-time", text: `${minToHm(it.s)}–${minToHm(it.s + it.dur)} · ${fmtDur(it.dur)}` });
        b.addEventListener("dblclick", () => open(t.file));
        this.scope.draggable(b, t.file.path);
      });
      if (isToday) { const nl = lane.createDiv("samaya-now"); nl.dataset.startH = String(startH); }
    }
    this.updateNowLines();
    if (this.scrolledFor !== this.weekStart) {
      this.scrolledFor = this.weekStart;
      const nl = body.querySelector<HTMLElement>(".samaya-now");
      this.scrollTop = nl ? Math.max(0, parseFloat(nl.style.top) - 150) : Math.max(0, (8 - startH) * HOUR_H);
    }
    scroll.scrollTop = this.scrollTop;
  }

  private updateNowLines() {
    const now = new Date();
    this.root.querySelectorAll<HTMLElement>(".samaya-now").forEach(nl => {
      nl.style.top = `${((now.getHours() * 60 + now.getMinutes() - Number(nl.dataset.startH ?? 0) * 60) / 60) * this.hourH}px`;
    });
  }
}
