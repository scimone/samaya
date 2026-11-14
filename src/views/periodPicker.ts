import { setIcon } from "obsidian";
import { dismissable } from "./dayPicker";
import { srName } from "./srname";
import type { Period } from "../journal";
import { parseYmd, today } from "../util";
import { sameSpan, spanStart } from "../journaldigest";

type Coarse = Extract<Period, "monthly" | "quarterly" | "yearly">;

/** A small popover for the picker of coarse notes, in place of a day calendar: the months of a year, the quarters of a year, or a page of years. Picking a cell calls `run` with the first day of that period. */
export function openPeriodPicker(anchor: HTMLElement, p: Coarse, value: string, run: (date: string) => void): void {
  const sel = parseYmd(value).getFullYear(); let year = sel;
  const box = document.body.createDiv({ cls: "samaya-pp", attr: { role: "dialog" } }); srName(box, p === "monthly" ? "Pick a month" : p === "quarterly" ? "Pick a quarter" : "Pick a year");
  const close = dismissable(box, anchor);
  const draw = () => {
    box.empty();
    const head = box.createDiv("samaya-pp-head"); const span = p === "yearly" ? 12 : 1; const start = year - 5;
    const step = (icon: string, label: string, n: number) => { const b = head.createEl("button", { cls: "samaya-pp-step", attr: { "aria-label": label } }); setIcon(b, icon); b.onclick = () => { year += n * span; draw(); }; };
    step("chevron-left", p === "yearly" ? "Earlier years" : "Previous year", -1);
    head.createSpan({ cls: "samaya-pp-title", text: p === "yearly" ? `${start} – ${start + 11}` : String(year) });
    step("chevron-right", p === "yearly" ? "Later years" : "Next year", 1);
    const cells: Array<{ date: string; text: string; sub?: string }> =
      p === "monthly" ? Array.from({ length: 12 }, (_, m) => { const d = new Date(year, m, 1); return { date: `${year}-${String(m + 1).padStart(2, "0")}-01`, text: d.toLocaleDateString(undefined, { month: "short" }) }; })
      : p === "quarterly" ? Array.from({ length: 4 }, (_, q) => { const m = (i: number) => new Date(year, q * 3 + i, 1).toLocaleDateString(undefined, { month: "short" }); return { date: `${year}-${String(q * 3 + 1).padStart(2, "0")}-01`, text: `Q${q + 1}`, sub: `${m(0)} – ${m(2)}` }; })
      : Array.from({ length: 12 }, (_, i) => ({ date: `${start + i}-01-01`, text: String(start + i) }));
    const grid = box.createDiv(`samaya-pp-grid is-${p}`); const now = today();
    for (const c of cells) {
      const b = grid.createEl("button", { cls: "samaya-pp-cell" + (sameSpan(p, c.date, value) ? " is-selected" : "") + (sameSpan(p, c.date, now) ? " is-now" : ""), attr: { title: c.sub ? `${c.text} (${c.sub})` : c.text } });
      b.createSpan({ text: c.text }); if (c.sub) b.createSpan({ cls: "samaya-pp-sub", text: c.sub });
      b.onclick = () => { close(); run(spanStart(p, c.date)); };
    }
  };
  draw();
  const r = anchor.getBoundingClientRect(); const w = box.offsetWidth;
  box.style.top = `${r.bottom + 6}px`; box.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  box.querySelector<HTMLElement>(".is-selected, .is-now, .samaya-pp-cell")?.focus();
}
