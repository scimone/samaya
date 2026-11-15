import { setIcon } from "obsidian";

/** A sort dropdown with an ascending / descending toggle next to it. */
export function renderSort<K extends string>(parent: HTMLElement, label: string, options: ReadonlyArray<[K, string]>, key: K, desc: boolean, onChange: (key: K, desc: boolean) => void) {
  const sel = parent.createEl("select", { cls: "dropdown samaya-sortsel", attr: { "aria-label": label } });
  for (const [v, t] of options) sel.createEl("option", { text: t, value: v });
  sel.value = key; sel.onchange = () => onChange(sel.value as K, desc);
  const b = parent.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": desc ? "Descending (click for ascending)" : "Ascending (click for descending)" } });
  setIcon(b, desc ? "arrow-down-wide-narrow" : "arrow-up-narrow-wide"); b.onclick = () => onChange(sel.value as K, !desc);
}
