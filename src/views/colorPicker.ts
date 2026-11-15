import { PALETTE } from "../itemcolor";

/** A small floating palette at (x, y); `onPick` gets the chosen hex. */
export function openColorPicker(x: number, y: number, current: string, onPick: (hex: string) => void) {
  document.querySelectorAll(".samaya-colorpick").forEach(e => e.remove());
  const box = document.body.createDiv({ cls: "samaya-colorpick", attr: { role: "dialog", "aria-label": "Choose a colour" } });
  const close = () => { box.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); };
  const away = (e: Event) => { if (!box.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  for (const c of PALETTE) {
    const b = box.createEl("button", { cls: "samaya-colorpick-dot" + (c.hex === current.toLowerCase() ? " is-current" : ""), attr: { "aria-label": c.name } });
    b.style.background = c.hex; b.onclick = () => { close(); onPick(c.hex); };
  }
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`; box.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
  window.setTimeout(() => { document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", key, true); }, 0);
}
