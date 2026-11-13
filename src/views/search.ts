import type { App, TFile } from "obsidian";

/** The search box of the page headings (same look in every view). Typing redraws the page after a short pause, then puts the cursor back. */
export function renderSearch(parent: HTMLElement, placeholder: string, value: string, onChange: (q: string) => void, redraw: () => void, setTimer: (id: number) => void): HTMLInputElement {
  const input = parent.createEl("input", { cls: "samaya-mt-search", type: "search", placeholder }); input.value = value;
  let t = 0;
  input.oninput = () => {
    onChange(input.value); window.clearTimeout(t);
    t = window.setTimeout(() => { redraw(); const el = parent.ownerDocument.querySelector<HTMLInputElement>(`input.samaya-mt-search[placeholder="${placeholder}"]`); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, 150);
    setTimer(t);
  };
  return input;
}

/** Lower-cased note text, read in the background once per change, so a search can look inside notes. */
export class NoteText {
  private cache = new Map<string, { mtime: number; body: string }>(); private inflight = new Set<string>();
  constructor(private app: App) {}
  get(f: TFile): string { return this.cache.get(f.path)?.body ?? ""; }
  /** Read what is missing or changed; `done` runs once something new was read. */
  load(files: TFile[], done: () => void) {
    const todo = files.filter(f => this.cache.get(f.path)?.mtime !== f.stat.mtime && !this.inflight.has(f.path)); if (!todo.length) return;
    for (const f of todo) this.inflight.add(f.path);
    void Promise.all(todo.map(async f => {
      try { this.cache.set(f.path, { mtime: f.stat.mtime, body: (await this.app.vault.cachedRead(f)).toLowerCase() }); } catch { this.cache.set(f.path, { mtime: f.stat.mtime, body: "" }); }
      this.inflight.delete(f.path);
    })).then(done);
  }
}
/** Every word of the query must appear in the text. */
export const matches = (text: string, q: string): boolean => q.toLowerCase().split(/\s+/).filter(Boolean).every(w => text.includes(w));
