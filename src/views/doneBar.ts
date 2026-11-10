/** Thin progress bar: how many of the day's tasks are done. */
export function renderDoneBar(parent: HTMLElement, done: number, total: number, label = true) {
  const wrap = parent.createDiv("samaya-donebar");
  if (label) wrap.createDiv({ cls: "samaya-donebar-label", text: total ? `${done} of ${total} tasks done` : "No tasks planned" });
  const bar = wrap.createDiv("samaya-donebar-track"); const fill = bar.createDiv("samaya-donebar-fill");
  fill.style.width = `${total ? (done / total) * 100 : 0}%`; fill.toggleClass("is-complete", total > 0 && done === total);
}

/** Burst of sparks from `anchor` (a short reward when every task of the day is checked). Lives on document.body so a re-render cannot cut it short. */
export function celebrate(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect(); if (!r.width && !r.height) return;
  const host = document.body.createDiv("samaya-sparks");
  host.style.left = `${r.left + r.width / 2}px`; host.style.top = `${r.top + r.height / 2}px`;
  const colors = ["var(--samaya-green)", "#f5c542", "#ffffff", "#7be0a0", "#ff9f5a"];
  const n = 26;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.5; const d = 40 + Math.random() * 70;
    const sp = host.createDiv("samaya-spark");
    sp.style.setProperty("--dx", `${Math.cos(a) * d}px`); sp.style.setProperty("--dy", `${Math.sin(a) * d}px`);
    sp.style.setProperty("--c", colors[i % colors.length]); sp.style.animationDelay = `${Math.random() * 120}ms`;
    sp.style.setProperty("--s", `${3 + Math.random() * 4}px`);
  }
  window.setTimeout(() => host.remove(), 1400);
}
