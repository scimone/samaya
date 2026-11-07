/** Thin progress bar: how many of the day's tasks are done. */
export function renderDoneBar(parent: HTMLElement, done: number, total: number) {
  const wrap = parent.createDiv("samaya-donebar");
  wrap.createDiv({ cls: "samaya-donebar-label", text: total ? `${done} of ${total} tasks done` : "No tasks planned" });
  const bar = wrap.createDiv("samaya-donebar-track"); const fill = bar.createDiv("samaya-donebar-fill");
  fill.style.width = `${total ? (done / total) * 100 : 0}%`; fill.toggleClass("is-complete", total > 0 && done === total);
}
