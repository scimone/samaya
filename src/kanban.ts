// Pure kanban grouping for the tickets board: ordered status columns, one lane per ticket project. No Obsidian imports (unit-tested).
export const NO_PROJECT = "No project";

/** Rank of a status in a typical workflow: open / to do first, done / closed last, anything else between. */
export function statusRank(status: string): number {
  const s = status.toLowerCase();
  if (/(done|closed|resolved|complete|finished|released|cancel|won'?t)/.test(s) && !/\b(not|un)\s?(done|resolved|complete|finished|released)|incomplete/.test(s)) return 3;
  if (/(review|test|verif|qa|accept)/.test(s)) return 2;
  if (/(progress|doing|develop|started|active)/.test(s)) return 1.5;
  if (/(backlog|open|todo|to do|new|ready|selected|reopen)/.test(s)) return 0;
  return 1;
}
/** A finished ticket (done / closed / resolved / cancelled ...), the one definition for hiding and filtering. */
export const isDoneState = (status: string): boolean => statusRank(status) === 3;
export function orderStatuses(statuses: string[]): string[] {
  return [...new Set(statuses)].sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b));
}
export interface Lane<T> { project: string; cells: Map<string, T[]>; count: number; }
/** Columns (statuses) and lanes (projects, A-Z, tickets without a project last). */
export function groupTickets<T extends { state: string; project: string }>(items: T[]): { columns: string[]; lanes: Lane<T>[] } {
  const columns = orderStatuses(items.map(t => t.state || "No status"));
  const by = new Map<string, Lane<T>>();
  for (const t of items) {
    const p = t.project || NO_PROJECT; const st = t.state || "No status";
    const lane = by.get(p) ?? { project: p, cells: new Map<string, T[]>(), count: 0 }; by.set(p, lane);
    (lane.cells.get(st) ?? lane.cells.set(st, []).get(st)!).push(t); lane.count++;
  }
  const lanes = [...by.values()].sort((a, b) => Number(a.project === NO_PROJECT) - Number(b.project === NO_PROJECT) || a.project.localeCompare(b.project));
  return { columns, lanes };
}
