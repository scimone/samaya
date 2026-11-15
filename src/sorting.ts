// Sort orders of the Projects chart and the Tickets board. Pure (unit-tested): undated / unset items always come last, whichever the direction.
export type ProjectSort = "start" | "end" | "name" | "ticket";
export type TicketSort = "key" | "date" | "name";
export const PROJECT_SORTS: ReadonlyArray<[ProjectSort, string]> = [["start", "Start date"], ["end", "End date"], ["name", "Name"], ["ticket", "Ticket project"]];
export const TICKET_SORTS: ReadonlyArray<[TicketSort, string]> = [["key", "Ticket key"], ["date", "Date added"], ["name", "Title"]];

const text = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
/** Compare with a direction; an empty value ("" / undefined) goes after every other one in both directions. */
function cmp<V extends string | number>(a: V | undefined | "", b: V | undefined | "", desc: boolean): number {
  const ea = a === undefined || a === "", eb = b === undefined || b === "";
  if (ea || eb) return Number(ea) - Number(eb);
  const r = typeof a === "number" ? a - (b as number) : text(a as string, b as string);
  return desc ? -r : r;
}
export function sortProjects<P extends { name: string; span: { start: string; end: string } | null }>(items: P[], by: ProjectSort, desc: boolean, ticketOf: (p: P) => string): P[] {
  const val = (p: P): string => by === "start" ? p.span?.start ?? "" : by === "end" ? p.span?.end ?? "" : by === "ticket" ? ticketOf(p) : p.name;
  return [...items].sort((a, b) => cmp(val(a), val(b), desc) || text(a.name, b.name));
}
export function sortTickets<T extends { key: string; summary: string }>(items: T[], by: TicketSort, desc: boolean, dateOf: (t: T) => number): T[] {
  const val = (t: T): string | number => by === "date" ? dateOf(t) : by === "name" ? t.summary : t.key;
  return [...items].sort((a, b) => cmp(val(a), val(b), desc) || text(a.key, b.key));
}
