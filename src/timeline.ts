/** Side-by-side layout for overlapping time items. Items must be sorted by start. */
export function layoutItems<T extends { s: number; dur: number }>(items: T[]): Map<T, { col: number; n: number }> {
  const slot = new Map<T, { col: number; n: number }>();
  let cluster: T[] = []; let cols: number[] = []; let clusterEnd = -1;
  const flush = () => { const n = Math.max(1, cols.length); cluster.forEach(c => (slot.get(c)!.n = n)); cluster = []; cols = []; };
  for (const it of items) {
    if (it.s >= clusterEnd) { flush(); clusterEnd = -1; }
    let c = cols.findIndex(end => end <= it.s); if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = it.s + it.dur; slot.set(it, { col: c, n: 1 }); cluster.push(it); clusterEnd = Math.max(clusterEnd, it.s + it.dur);
  }
  flush();
  return slot;
}
