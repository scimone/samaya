import { setIcon } from "obsidian";

export interface DateNavOpts {
  /** "box": arrows and label in one bordered control (week and day headings; the label opens a date picker when `pick` is set). "plain": plain arrows around a date button with a calendar picker (day header). */
  variant: "box" | "plain";
  label: string;
  prevLabel: string; nextLabel: string;
  onPrev(): void; onNext(): void;
  /** plain: clicking the date opens a date picker preset to `value` */
  pick?: { value: string; run(value: string): void };
}

/** ‹ date › : the date navigation of the planner's week heading and of the day header. */
export function renderDateNav(parent: HTMLElement, o: DateNavOpts): HTMLElement {
  if (o.variant === "box") {
    const nav = parent.createDiv("samaya-weeknav");
    const step = (icon: string, label: string, run: () => void) => { const b = nav.createEl("button", { cls: "samaya-weeknav-step", attr: { "aria-label": label, title: label } }); setIcon(b, icon); b.onclick = run; };
    step("chevron-left", o.prevLabel, o.onPrev);
    const lab = nav.createSpan({ cls: "samaya-weeknav-label", text: o.label });
    if (o.pick) { // the label opens a date picker (day view); the native input sits invisibly over it
      const pick = o.pick; lab.addClass("is-pickable"); lab.setAttr("aria-label", "Pick a date");
      const picker = lab.createEl("input", { type: "date", cls: "samaya-weeknav-datepick" }); picker.value = pick.value;
      picker.addEventListener("change", () => { if (picker.value) pick.run(picker.value); });
      lab.onclick = e => { if (e.target !== picker) { try { picker.showPicker(); } catch { picker.focus(); picker.click(); } } };
    }
    step("chevron-right", o.nextLabel, o.onNext);
    return nav;
  }
  const dr = parent.createDiv("samaya-info-daterow");
  const arrow = (icon: string, label: string, run: () => void) => { const b = dr.createEl("button", { cls: "samaya-info-arrow clickable-icon", attr: { "aria-label": label } }); setIcon(b, icon); b.onclick = run; };
  arrow("chevron-left", o.prevLabel, o.onPrev);
  const dateBtn = dr.createEl("button", { cls: "samaya-info-date", attr: { "aria-label": "Pick a date" } });
  setIcon(dateBtn.createSpan("samaya-info-date-icon"), "calendar");
  dateBtn.createSpan({ text: o.label });
  if (o.pick) {
    const pick = o.pick;
    const picker = dateBtn.createEl("input", { type: "date", cls: "samaya-info-datepick" }); picker.value = pick.value; // sits invisibly over the button so the native calendar opens right there
    picker.addEventListener("change", () => { if (picker.value) pick.run(picker.value); });
    dateBtn.onclick = e => { if (e.target !== picker) { try { picker.showPicker(); } catch { picker.focus(); picker.click(); } } };
  }
  arrow("chevron-right", o.nextLabel, o.onNext);
  return dr;
}

/** The soft accent pill that jumps back ("Today", "This week"); the arrow shows which way it goes. */
export function renderResetPill(parent: HTMLElement, text: string, hint: string, dir: "left" | "right", run: () => void): HTMLElement {
  const r = parent.createEl("button", { cls: "samaya-datereset", attr: { title: hint, "aria-label": hint } });
  setIcon(r.createSpan("samaya-datereset-icon"), dir === "right" ? "arrow-right" : "arrow-left");
  r.createSpan({ text }); r.onclick = run;
  return r;
}
