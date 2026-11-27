import { Menu, Notice, TAbstractFile, TFile, normalizePath, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { closeSide, expandSide, sideBack, sideBackTarget, sideLeaf, sideTrack, sideWaitDone } from "../openfile";
import { patchNote, prefixOf, readTask, readTicket } from "../model";
import { projectsPrefix } from "../projects";
import { safeFileName } from "../util";
import { taskLine } from "./taskCard";
import { pageTree } from "../nestedpages";

/** The icon buttons (back to the note before, close, open in full page), left of the title (no border, no fill until hovered). The tooltip is Obsidian's (aria-label): never add a `title` as well, that shows a second one. */
function addButtons(parent: HTMLElement, plugin: SamayaPlugin, back: TFile | null, first = false) {
  const g = createDiv("samaya-side-btns"); g.dataset.back = back?.path ?? ""; if (first) parent.prepend(g); else parent.append(g); // on the left, before the title
  const b = (icon: string, label: string, cls: string, run: () => void) => { const x = g.createEl("button", { cls: `samaya-side-btn clickable-icon ${cls}`, attr: { "aria-label": label } }); setIcon(x, icon); x.onclick = run; };
  if (back) b("arrow-left", `Back to ${back.basename}`, "is-back", () => { void sideBack(plugin.app); });
  b("chevrons-right", "Close side pane", "is-close", () => closeSide(plugin.app));
  b("maximize-2", "Open in full page", "is-expand", () => { void expandSide(plugin.app); });
}
/** The three-dot menu at the right of the bar: delete a subpage of this note, or this note when it is a subpage. */
function addMore(bar: HTMLElement, plugin: SamayaPlugin, file: TFile) {
  const x = bar.createEl("button", { cls: "samaya-side-btn samaya-side-more clickable-icon", attr: { "aria-label": "More" } }); setIcon(x, "more-horizontal");
  x.onclick = e => {
    const { subpages, self } = pageTree(file), m = new Menu(), ask = (t: TAbstractFile) => { void plugin.app.fileManager.promptForDeletion(t); };
    for (const s of subpages) m.addItem(i => i.setTitle(`Delete subpage "${s.file.basename}"${s.kids ? " and its subpages" : ""}`).setIcon("trash").setWarning(true).onClick(() => ask(s.target)));
    if (subpages.length && self) m.addSeparator();
    if (self) m.addItem(i => i.setTitle("Delete this page").setIcon("trash").setWarning(true).onClick(() => ask(self)));
    m.showAtMouseEvent(e);
  };
}
const clear = (el: HTMLElement) => {
  el.querySelectorAll(":scope > .samaya-side-bar, :scope > .samaya-journal-bar .samaya-side-btns").forEach(x => x.remove());
  el.removeClass("samaya-side-note");
};

/** What the bar calls a note: a ticket "KEY • title", a meeting its title, a task its title, any other note its file name. */
function titleOf(plugin: SamayaPlugin, file: TFile): string {
  const s = plugin.settings;
  if (file.path.startsWith(prefixOf(s.ticketsPath))) { const k = readTicket(plugin.app, file); return k.summary ? `${k.key} • ${k.summary}` : k.key; }
  if (file.path.startsWith(normalizePath(s.eventNotesFolder.trim() || "Meetings") + "/")) {
    const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter; const t = fm?.title == null ? "" : String(fm.title).trim(); return t || file.basename;
  }
  if (file.path.startsWith(prefixOf(s.tasksPath))) return readTask(plugin.app, file).title;
  return file.basename;
}

/** How the title of this note can be changed from the bar: meetings write their `title` property, tasks and projects rename the note. Tickets, journal notes and others: not at all. */
function renamerOf(plugin: SamayaPlugin, file: TFile): ((name: string) => Promise<void>) | null {
  const s = plugin.settings;
  if (file.path.startsWith(normalizePath(s.eventNotesFolder.trim() || "Meetings") + "/")) return name => patchNote(plugin.app, file, { title: name });
  if (file.path.startsWith(prefixOf(s.tasksPath)) || file.path.startsWith(projectsPrefix(s))) return async name => {
    const base = safeFileName(name); if (!base || base === file.basename) return;
    const dir = file.parent && !file.parent.isRoot() ? file.parent.path + "/" : ""; const path = `${dir}${base}.${file.extension}`;
    if (plugin.app.vault.getAbstractFileByPath(path)) { new Notice(`"${base}" already exists`); return; }
    await plugin.app.fileManager.renameFile(file, path);
  };
  return null;
}
/** Click the title to edit it in place: Enter or leaving the field saves, Escape cancels. */
function makeEditable(el: HTMLElement, current: string, rename: (name: string) => Promise<void>) {
  el.addClass("is-editable"); el.setAttr("aria-label", "Click to rename");
  el.onclick = () => {
    const input = createEl("input", { cls: "samaya-side-title-input", type: "text", value: current });
    el.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return; done = true; input.replaceWith(el);
      const v = input.value.trim(); if (save && v && v !== current) void rename(v);
    };
    input.onkeydown = e => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); e.stopPropagation(); };
    input.onblur = () => finish(true);
  };
}

/**
 * The note in the side pane gets a bar on top of it: the two buttons, then the note's title (its own heading is hidden below).
 * A note that has a bar of its own (a journal note) gets the buttons at the start of that bar. A task's bar also has its checkbox, and on the right
 * the clock and the Focus button. Every other pane is cleaned up. Runs after the journal bars have been drawn.
 */
export function renderSideBars(plugin: SamayaPlugin) {
  const ws = plugin.app.workspace; const side = sideLeaf(plugin.app);
  ws.iterateRootLeaves(leaf => {
    const el = leaf.view?.containerEl; if (!el) return;
    const file = (leaf.view as { file?: TFile }).file;
    if (leaf !== side || leaf.view.getViewType() !== "markdown" || !file) { clear(el); return; }
    sideTrack(file); const back = sideBackTarget(plugin.app);
    const jbar = el.querySelector<HTMLElement>(":scope > .samaya-journal-bar");
    if (jbar) {
      el.querySelectorAll(":scope > .samaya-side-bar").forEach(x => x.remove()); el.removeClass("samaya-side-note");
      const btns = jbar.querySelector<HTMLElement>(".samaya-side-btns");
      if (btns && btns.dataset.back !== (back?.path ?? "")) btns.remove();
      if (!jbar.querySelector(".samaya-side-btns")) addButtons(jbar, plugin, back, true);
      return;
    }
    const task = el.hasClass("samaya-task-note"); const title = titleOf(plugin, file);
    const line = task ? taskLine(plugin, file, title) : null; // checkbox, title, clock, Focus
    const tree = plugin.nested.usable(file) ? pageTree(file) : null; const more = !!tree && (tree.subpages.length > 0 || !!tree.self);
    const key = `${file.path}|${title}|${line?.dataset.key ?? ""}|${back?.path ?? ""}|${more ? tree!.subpages.map(s => s.file.path).join(",") + (tree!.self?.path ?? "") : ""}`;
    el.toggleClass("samaya-side-note", true);
    const have = el.querySelector<HTMLElement>(":scope > .samaya-side-bar");
    if (have?.dataset.key === key) return;
    have?.remove();
    const content = el.querySelector(":scope > .view-content"); if (!content) return;
    const bar = createDiv("samaya-side-bar"); bar.dataset.key = key;
    addButtons(bar, plugin, back);
    if (line) bar.append(line); else bar.createDiv({ cls: "samaya-side-title", text: title, attr: { "aria-label": file.path } });
    const rename = renamerOf(plugin, file); const tEl = bar.querySelector<HTMLElement>(".samaya-side-title");
    if (rename && tEl) makeEditable(tEl, title, rename);
    if (more) addMore(bar, plugin, file);
    el.insertBefore(bar, content);
  });
  sideWaitDone(side); // bars, hidden headings and the journal bar are all in place: show the note
}
