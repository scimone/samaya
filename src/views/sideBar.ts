import { TFile, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { closeSide, expandSide, sideLeaf } from "../openfile";

/** The two icon buttons (no border, no fill until hovered): close the side pane, open the note in a full page. */
function addButtons(parent: HTMLElement, plugin: SamayaPlugin) {
  const g = parent.createDiv("samaya-side-btns");
  const b = (icon: string, label: string, run: () => void) => { const x = g.createEl("button", { cls: "samaya-hd-icon", attr: { "aria-label": label, title: label } }); setIcon(x, icon); x.onclick = run; };
  b("chevrons-right", "Close side pane", () => closeSide(plugin.app));
  b("maximize-2", "Open in full page", () => { void expandSide(plugin.app); });
}
const clear = (el: HTMLElement) => {
  el.querySelectorAll(":scope > .samaya-side-bar, :scope > .samaya-journal-bar .samaya-side-btns").forEach(x => x.remove());
  el.removeClass("samaya-side-note");
};

/**
 * The note in the side pane gets a bar on top of it: the note's title (its own heading is hidden below) and the two buttons.
 * A note that has a bar of its own (a journal note) gets the buttons in that bar; a task note keeps its title line (checkbox, clock), so its bar is only the buttons.
 * Every other pane is cleaned up. Runs after the journal bars have been drawn.
 */
export function renderSideBars(plugin: SamayaPlugin) {
  const ws = plugin.app.workspace; const side = sideLeaf(plugin.app);
  ws.iterateRootLeaves(leaf => {
    const el = leaf.view?.containerEl; if (!el) return;
    const file = (leaf.view as { file?: TFile }).file;
    if (leaf !== side || leaf.view.getViewType() !== "markdown" || !file) { clear(el); return; }
    const jbar = el.querySelector<HTMLElement>(":scope > .samaya-journal-bar");
    if (jbar) {
      el.querySelectorAll(":scope > .samaya-side-bar").forEach(x => x.remove()); el.removeClass("samaya-side-note");
      const right = jbar.querySelector<HTMLElement>(".samaya-planner-right") ?? jbar;
      if (!jbar.querySelector(".samaya-side-btns")) addButtons(right, plugin);
      return;
    }
    const task = el.hasClass("samaya-task-note"); const key = `${file.path}|${task}`;
    el.toggleClass("samaya-side-note", true);
    const have = el.querySelector<HTMLElement>(":scope > .samaya-side-bar");
    if (have?.dataset.key === key) return;
    have?.remove();
    const content = el.querySelector(":scope > .view-content"); if (!content) return;
    const bar = createDiv("samaya-side-bar"); bar.dataset.key = key;
    if (!task) bar.createDiv({ cls: "samaya-side-title", text: file.basename, attr: { title: file.path } });
    addButtons(bar, plugin);
    el.insertBefore(bar, content);
  });
}
