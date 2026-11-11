import { setIcon } from "obsidian";

export interface DateNavOpts {
  label: string;
  prevLabel: string; nextLabel: string;
  onPrev(): void; onNext(): void;
  /** the label opens a date picker preset to `value` (the native input sits invisibly over it); `label` names it for assistive tech */
  pick?: { value: string; label?: string; run(value: string): void };
  /** show this icon as the (picker) button instead of the date text: the heading already says which date it is */
  icon?: string;
}

/** ‹ date › in one bordered control: the date navigation of the day and week headings and of the Today sidebar. */
export function renderDateNav(parent: HTMLElement, o: DateNavOpts): HTMLElement {
  const nav = parent.createDiv("samaya-weeknav");
  const step = (icon: string, label: string, run: () => void) => { const b = nav.createEl("button", { cls: "samaya-weeknav-step", attr: { "aria-label": label, title: label } }); setIcon(b, icon); b.onclick = run; };
  step("chevron-left", o.prevLabel, o.onPrev);
  const asIcon = !!(o.icon && o.pick);
  const lab = nav.createSpan({ cls: "samaya-weeknav-label", text: asIcon ? "" : o.label });
  if (asIcon) { lab.addClass("is-icon"); setIcon(lab, o.icon!); }
  if (o.pick) {
    const pick = o.pick; const name = pick.label ?? "Pick a date";
    lab.addClass("is-pickable"); lab.setAttr("role", "button"); lab.setAttr("tabindex", "0"); lab.setAttr("aria-label", `${name} (${o.label})`); lab.setAttr("title", asIcon ? `${name} (${o.label})` : name);
    const picker = lab.createEl("input", { type: "date", cls: "samaya-weeknav-datepick", attr: { tabindex: "-1", "aria-hidden": "true" } }); picker.value = pick.value;
    picker.addEventListener("change", () => { if (picker.value) pick.run(picker.value); });
    const open = () => { try { picker.showPicker(); } catch { picker.focus(); picker.click(); } };
    lab.onclick = e => { if (e.target !== picker) open(); };
    lab.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
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
