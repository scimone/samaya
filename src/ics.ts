// Minimal, dependency-free ICS parser with basic RRULE expansion. Pure (no Obsidian imports) so it can be unit-tested.
export interface IcsEvent { title: string; start: Date; end: Date; allDay: boolean; }

function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}
function unescapeText(s: string): string { return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1"); }

function parseDate(value: string, params: string): { d: Date; allDay: boolean } | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, da, h, mi, s, z] = m;
  if (h === undefined || /VALUE=DATE(?!-)/.test(params)) return { d: new Date(+y, +mo - 1, +da), allDay: true };
  if (z) return { d: new Date(Date.UTC(+y, +mo - 1, +da, +h, +mi, +(s || 0))), allDay: false };
  return { d: new Date(+y, +mo - 1, +da, +h, +mi, +(s || 0)), allDay: false }; // floating / TZID treated as local
}

const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function expand(start: Date, end: Date, rrule: string, exdates: Set<number>, from: Date, to: Date): Array<[Date, Date]> {
  const r: Record<string, string> = {};
  rrule.split(";").forEach(p => { const [k, v] = p.split("="); r[k] = v; });
  const freq = r.FREQ, interval = parseInt(r.INTERVAL || "1", 10) || 1;
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const until = r.UNTIL ? parseDate(r.UNTIL, "")?.d : undefined;
  const byday = r.BYDAY ? r.BYDAY.split(",").map(x => DOW.indexOf(x.slice(-2))) : null;
  const dur = end.getTime() - start.getTime();
  const out: Array<[Date, Date]> = [];
  let n = 0;
  const push = (d: Date): boolean => {
    if (until && d > until) return false;
    if (n >= count) return false;
    n++;
    if (!exdates.has(d.getTime()) && d.getTime() + dur >= from.getTime() && d <= to) out.push([d, new Date(d.getTime() + dur)]);
    return d <= to;
  };
  const cur = new Date(start);
  for (let guard = 0; guard < 5000; guard++) {
    if (freq === "WEEKLY" && byday) {
      const weekStart = new Date(cur); weekStart.setDate(cur.getDate() - cur.getDay());
      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
        d.setHours(start.getHours(), start.getMinutes(), start.getSeconds());
        if (d < start || !byday.includes(d.getDay())) continue;
        if (!push(d)) return out;
      }
      cur.setDate(cur.getDate() + 7 * interval);
    } else {
      if (!push(new Date(cur))) return out;
      if (freq === "DAILY") cur.setDate(cur.getDate() + interval);
      else if (freq === "WEEKLY") cur.setDate(cur.getDate() + 7 * interval);
      else if (freq === "MONTHLY") cur.setMonth(cur.getMonth() + interval);
      else if (freq === "YEARLY") cur.setFullYear(cur.getFullYear() + interval);
      else return out;
    }
    if (cur > to) break;
  }
  return out;
}

export function parseIcs(text: string, from: Date, to: Date): IcsEvent[] {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  let ev: { summary?: string; dtstart?: { d: Date; allDay: boolean }; dtend?: { d: Date; allDay: boolean }; rrule?: string; ex: Set<number>; cancelled?: boolean } | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { ev = { ex: new Set() }; continue; }
    if (line === "END:VEVENT" && ev) {
      if (ev.dtstart && !ev.cancelled) {
        const s = ev.dtstart.d;
        const e = ev.dtend ? ev.dtend.d : new Date(s.getTime() + (ev.dtstart.allDay ? 86400000 : 3600000));
        const title = ev.summary || "(busy)";
        const add = (a: Date, b: Date) => events.push({ title, start: a, end: b, allDay: ev!.dtstart!.allDay });
        if (ev.rrule) expand(s, e, ev.rrule, ev.ex, from, to).forEach(([a, b]) => add(a, b));
        else if (e >= from && s <= to) add(s, e);
      }
      ev = null; continue;
    }
    if (!ev) continue;
    const idx = line.indexOf(":"); if (idx < 0) continue;
    const head = line.slice(0, idx), value = line.slice(idx + 1);
    const [name, ...rest] = head.split(";"); const params = rest.join(";");
    switch (name.toUpperCase()) {
      case "SUMMARY": ev.summary = unescapeText(value); break;
      case "DTSTART": { const p = parseDate(value, params); if (p) ev.dtstart = p; break; }
      case "DTEND": { const p = parseDate(value, params); if (p) ev.dtend = p; break; }
      case "RRULE": ev.rrule = value; break;
      case "EXDATE": value.split(",").forEach(v => { const p = parseDate(v, params); if (p) ev!.ex.add(p.d.getTime()); }); break;
      case "STATUS": if (value.toUpperCase() === "CANCELLED") ev.cancelled = true; break;
    }
  }
  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}
