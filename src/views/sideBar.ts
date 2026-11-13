import { Notice, TFile, normalizePath, setIcon } from "obsidian";
import type SamayaPlugin from "../main";
import { closeSide, expandSide, sideLeaf, sideWaitDone } from "../openfile";
import { patchNote, prefixOf, readTask, readTicket } from "../model";
import { projectsPrefix } from "../projects";
import { safeFileName } from "../util";
import { taskLine } from "./taskCard";

/** The two icon buttons, left of the title (no border, no fill until hovered). The tooltip is Obsidian's (aria-label): never add a `title` as well, that shows a second one. */
function addButtons(parent: HTMLElement, plugin: SamayaPlugin, first = false) {
  const g = createDiv("samaya-side-btns"); if (first) parent.prepend(g); else parent.append(g); // on the left, before the title
  const b = (icon: string, label: string, cls: string, run: () => void) => { const x = g.createEl("button", { cls: `samaya-side-btn clickable-icon ${cls}`, attr: { "aria-label": label } }); setIcon(x, icon); x.onclick = run; };
  b("chevrons-right", "Close side pane", "is-close", () => closeSide(plugin.app));
  b("maximize-2", "Open in full page", "is-expand", () => { void expandSide(plugin.app); });
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
    const jbar = el.querySelector<HTMLElement>(":scope > .samaya-journal-bar");
    if (jbar) {
      el.querySelectorAll(":scope > .samaya-side-bar").forEach(x => x.remove()); el.removeClass("samaya-side-note");
      if (!jbar.querySelector(".samaya-side-btns")) addButtons(jbar, plugin, true);
      return;
    }
    const task = el.hasClass("samaya-task-note"); const title = titleOf(plugin, file);
    const line = task ? taskLine(plugin, file, title) : null; // checkbox, title, clock, Focus
    const key = `${file.path}|${title}|${line?.dataset.key ?? ""}`;
    el.toggleClass("samaya-side-note", true);
    const have = el.querySelector<HTMLElement>(":scope > .samaya-side-bar");
    if (have?.dataset.key === key) return;
    have?.remove();
    const content = el.querySelector(":scope > .view-content"); if (!content) return;
    const bar = createDiv("samaya-side-bar"); bar.dataset.key = key;
    addButtons(bar, plugin);
    if (line) bar.append(line); else bar.createDiv({ cls: "samaya-side-title", text: title, attr: { "aria-label": file.path } });
    const rename = renamerOf(plugin, file); const tEl = bar.querySelector<HTMLElement>(".samaya-side-title");
    if (rename && tEl) makeEditable(tEl, title, rename);
    el.insertBefore(bar, content);
  });
  sideWaitDone(side); // bars, hidden headings and the journal bar are all in place: show the note
}
