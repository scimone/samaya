import { setIcon } from "obsidian";

export interface DateNavOpts {
  /** text between the arrows */
  label: string;
  prevLabel: string; nextLabel: string;
  onPrev(): void; onNext(): void;
  /** clicking the label opens a date picker preset to `value` */
  pick?: { value: string; run(value: string): void };
  /** the label gets room for a typical text (week range), so the arrows do not jump while you step */
  wide?: boolean;
}

/** ‹ [calendar] label › in one bordered control: the date navigation of the planner's week heading and of the day sidebar. */
export function renderDateNav(parent: HTMLElement, o: DateNavOpts): HTMLElement {
  const nav = parent.createDiv("samaya-datenav");
  const step = (icon: string, label: string, run: () => void) => { const b = nav.createEl("button", { cls: "samaya-datenav-step", attr: { "aria-label": label, title: label } }); setIcon(b, icon); b.onclick = run; };
  step("chevron-left", o.prevLabel, o.onPrev);
  const lbl = nav.createEl("button", { cls: "samaya-datenav-label" + (o.wide ? " is-wide" : ""), attr: { "aria-label": o.pick ? "Pick a date" : o.label } });
  setIcon(lbl.createSpan("samaya-datenav-icon"), "calendar");
  lbl.createSpan({ text: o.label });
  if (o.pick) {
    const pick = o.pick;
    const input = lbl.createEl("input", { type: "date", cls: "samaya-datenav-pick" }); input.value = pick.value; // sits invisibly over the label so the native calendar opens right there
    input.addEventListener("change", () => { if (input.value) pick.run(input.value); });
    lbl.onclick = e => { if (e.target !== input) { try { input.showPicker(); } catch { input.focus(); input.click(); } } };
  }
  step("chevron-right", o.nextLabel, o.onNext);
  return nav;
}

/** The soft accent pill that jumps back ("Today", "This week"); the arrow shows which way it goes. */
export function renderResetPill(parent: HTMLElement, text: string, hint: string, dir: "left" | "right", run: () => void): HTMLElement {
  const r = parent.createEl("button", { cls: "samaya-datereset", attr: { title: hint, "aria-label": hint } });
  setIcon(r.createSpan("samaya-datereset-icon"), dir === "right" ? "arrow-right" : "arrow-left");
  r.createSpan({ text }); r.onclick = run;
  return r;
}
