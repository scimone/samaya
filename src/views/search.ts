import type { App, TFile } from "obsidian";

/** Which search box had the cursor when the page was redrawn: the new box takes it back (set while redrawing, cleared by the first box that matches). */
let refocus = ""; let refocusAt = 0; // (valid for a second: a redraw may be async, but a box drawn much later is not the one that had the cursor)
/** The search box of the page headings (same look in every view). Typing redraws the page after a short pause, then puts the cursor back; a redraw never interrupts an IME composition. */
export function renderSearch(parent: HTMLElement, placeholder: string, value: string, onChange: (q: string) => void, redraw: () => void, setTimer: (id: number) => void): HTMLInputElement {
  const input = parent.createEl("input", { cls: "samaya-mt-search", type: "search", placeholder }); input.value = value;
  if (refocus === placeholder && Date.now() - refocusAt < 1000) { refocus = ""; window.requestAnimationFrame(() => { if (!input.isConnected) return; input.focus(); input.setSelectionRange(input.value.length, input.value.length); }); }
  let t = 0;
  const later = () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => { refocus = input.ownerDocument.activeElement === input ? placeholder : ""; refocusAt = Date.now(); redraw(); }, 150);
    setTimer(t);
  };
  input.addEventListener("input", e => { onChange(input.value); if (!(e as InputEvent).isComposing) later(); });
  input.addEventListener("compositionend", () => { onChange(input.value); later(); });
  return input;
}

/**
 * Lower-cased note text, read in the background once per change, so a search can look inside notes.
 * Reading a file is slow (they queue up and hold back everything else that reads files), so notes are read two at a time, most recently changed first,
 * and a new `load` replaces what is still waiting; `clear` drops it (the view was closed).
 */
export class NoteText {
  private cache = new Map<string, { mtime: number; body: string }>(); private inflight = new Set<string>();
  private queue: TFile[] = []; private workers = 0; private done: () => void = () => {}; private drawn = 0;
  constructor(private app: App) {}
  get(f: TFile): string { return this.cache.get(f.path)?.body ?? ""; }
  /** Read what is missing or changed; `done` runs while the texts arrive (at most every 400 ms) and once more at the end. */
  load(files: TFile[], done: () => void) {
    this.done = done; this.drawn = Date.now();
    this.queue = files.filter(f => this.cache.get(f.path)?.mtime !== f.stat.mtime && !this.inflight.has(f.path)).sort((a, b) => b.stat.mtime - a.stat.mtime);
    while (this.workers < 2 && this.queue.length) { this.workers++; void this.work(); }
  }
  clear() { this.queue = []; this.done = () => {}; }
  private async work() {
    try {
      for (let f = this.queue.shift(); f; f = this.queue.shift()) {
        this.inflight.add(f.path); const mtime = f.stat.mtime; let body = "";
        try { body = (await this.app.vault.cachedRead(f)).toLowerCase(); } catch { /* unreadable: counts as empty */ }
        this.cache.set(f.path, { mtime, body }); this.inflight.delete(f.path);
        if (!this.queue.length || Date.now() - this.drawn > 400) this.done();
      }
    } finally { this.workers--; }
  }
}
/** Every word of the query must appear in the text. */
export const matches = (text: string, q: string): boolean => q.toLowerCase().split(/\s+/).filter(Boolean).every(w => text.includes(w));
