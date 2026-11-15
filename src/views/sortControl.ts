import { Menu, setIcon } from "obsidian";
import { ORDER_LABELS, SortOption } from "../sorting";

/**
 * One "Sort" button in the page header: it shows what the list is sorted by and in which direction, and highlights when that differs from the default.
 * Clicking opens a menu with the sort keys (checked = current) and, below, the two directions worded for that key ("Oldest first" / "A → Z").
 */
export function renderSort<K extends string>(parent: HTMLElement, options: ReadonlyArray<SortOption<K>>, key: K, desc: boolean, def: { key: K; desc: boolean }, onChange: (key: K, desc: boolean) => void) {
  const cur = options.find(o => o.key === key) ?? options[0];
  const [asc, dsc] = ORDER_LABELS[cur.kind];
  const b = parent.createEl("button", { cls: "samaya-sortbtn" + (key !== def.key || desc !== def.desc ? " is-custom" : ""), attr: { "aria-label": `Sort: ${cur.label}, ${desc ? dsc : asc}` } });
  setIcon(b.createSpan("samaya-sortbtn-icon"), "arrow-up-down");
  b.createSpan({ cls: "samaya-sortbtn-text", text: cur.label });
  setIcon(b.createSpan("samaya-sortbtn-dir"), desc ? "arrow-down" : "arrow-up");
  b.onclick = e => {
    const m = new Menu();
    for (const o of options) m.addItem(i => i.setTitle(o.label).setChecked(o.key === key).onClick(() => onChange(o.key, desc)));
    m.addSeparator();
    m.addItem(i => i.setTitle(asc).setIcon("arrow-up").setChecked(!desc).onClick(() => onChange(key, false)));
    m.addItem(i => i.setTitle(dsc).setIcon("arrow-down").setChecked(desc).onClick(() => onChange(key, true)));
    m.showAtMouseEvent(e);
  };
}
