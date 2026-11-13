import type SamayaPlugin from "./main";
import { calendarEnabled, calendarEvents } from "./calendar";
import type { CalendarEvent } from "./eventnotes";
import { fmtDur } from "./util";

const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** A banner in the meeting colour on top of the pane in front while a meeting is on (above the focus banner when both run). Nothing in the planner fades for it. */
export class MeetingBanner {
  private ev: CalendarEvent | null = null;
  private busy = false;
  constructor(private plugin: SamayaPlugin) {}

  init() {
    const p = this.plugin, ws = p.app.workspace;
    const ensure = () => this.ensure();
    p.registerInterval(window.setInterval(() => { void this.poll(); }, 15000));
    p.registerInterval(window.setInterval(() => this.tick(), 1000));
    p.registerEvent(ws.on("layout-change", ensure));
    p.registerEvent(ws.on("active-leaf-change", ensure));
    p.registerEvent(ws.on("file-open", ensure));
    p.registerEvent(p.app.metadataCache.on("changed", () => { void this.poll(); }));
    ws.onLayoutReady(() => { void this.poll(); });
  }

  /** Looks for the meeting running right now (timed events only). */
  async poll() {
    if (this.busy) return; this.busy = true;
    try {
      const now = new Date();
      const evs = calendarEnabled(this.plugin.settings) ? await calendarEvents(this.plugin, now, new Date(now.getTime() + 1)).catch(() => []) : [];
      const cur = evs.find(e => !e.allDay && e.start <= now && now < e.end) ?? null;
      const changed = (cur?.notePath ?? cur?.title ?? "") + cur?.start.getTime() !== (this.ev?.notePath ?? this.ev?.title ?? "") + this.ev?.start.getTime();
      this.ev = cur;
      if (changed) { document.querySelectorAll(".samaya-meet-bar").forEach(el => el.remove()); }
      this.ensure();
    } finally { this.busy = false; }
  }

  private ensure() {
    const ev = this.ev;
    if (!ev) { document.querySelectorAll(".samaya-meet-bar").forEach(el => el.remove()); return; }
    const ws = this.plugin.app.workspace;
    const host = ws.getMostRecentLeaf(ws.rootSplit)?.view?.containerEl; if (!host) return;
    if (host.querySelector(":scope > .samaya-meet-bar")) return;
    document.querySelectorAll(".samaya-meet-bar").forEach(el => el.remove());
    const bar = createDiv("samaya-meet-bar");
    const status = bar.createDiv("samaya-meet-status");
    status.createSpan({ cls: "samaya-meet-dot" }); status.createSpan({ cls: "samaya-meet-state", text: "In meeting" });
    bar.createSpan({ cls: "samaya-meet-title", text: ev.title });
    bar.createSpan({ cls: "samaya-meet-prog" });
    bar.createDiv("samaya-meet-meter");
    const header = host.querySelector(":scope > .view-header");
    if (header) header.after(bar); else host.prepend(bar); // always first: the focus banner goes underneath
    this.tick();
  }

  private tick() {
    const ev = this.ev; if (!ev) return;
    const now = Date.now(), a = ev.start.getTime(), b = ev.end.getTime();
    if (now >= b) { void this.poll(); return; }
    document.querySelectorAll<HTMLElement>(".samaya-meet-bar").forEach(bar => {
      bar.querySelector<HTMLElement>(".samaya-meet-prog")?.setText(`${hm(ev.start)}–${hm(ev.end)} · ${fmtDur(Math.ceil((b - now) / 60000))} left`);
      bar.style.setProperty("--p", `${Math.min(100, Math.max(0, ((now - a) / (b - a)) * 100))}%`);
    });
  }
}
