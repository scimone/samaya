import { Keymap, Menu, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type SamayaPlugin from "./main";
import { safe } from "./safe";
import { TextPromptModal } from "./modals";
import { nestPaths } from "./nestpaths";
import { prefixOf, rootOf } from "./model";
import { meetingsPrefix } from "./links";
import { periodLocation } from "./journal";

/** Notion-like pages: a page created from an unresolved link inside another page is nested under it. Under the hood the parent
 *  lives in a folder of its own name (with its children); the file explorer shows that folder as the parent page with a toggle. */
export class NestedPages {
  private style: HTMLStyleElement | null = null;
  private cleanups: (() => void)[] = [];
  private pending: { source: string; at: number } | null = null;
  private busy = false;
  private timer = 0;
  constructor(private plugin: SamayaPlugin) {}

  private get on() { return this.plugin.settings.nestedPagesOn; }

  init() {
    const p = this.plugin, { vault, workspace } = p.app;
    // remember which note an unresolved link was clicked in; the page it creates follows right after
    p.registerDomEvent(document, "click", e => {
      if (!this.on || !(e.target instanceof Element) || !e.target.closest(".is-unresolved")) return;
      const f = workspace.getActiveFile();
      this.pending = f && f.extension === "md" ? { source: f.path, at: Date.now() } : null;
    }, true);
    p.registerEvent(vault.on("create", f => {
      if (!this.on) return;
      const pend = this.pending;
      if (f instanceof TFile && f.extension === "md" && pend && Date.now() - pend.at < 3000) {
        this.pending = null;
        window.setTimeout(() => { safe(this.nest(pend.source, f), "nesting the page"); }, 150);
      }
      this.refresh();
    }));
    p.registerEvent(vault.on("rename", (f, old) => { if (this.on) { void this.followRename(f, old); this.refresh(); } }));
    p.registerEvent(vault.on("delete", () => this.refresh()));
    p.registerEvent(workspace.on("layout-change", () => this.refresh()));
    p.registerEvent(workspace.on("file-open", () => this.markActive()));
    p.register(() => this.teardown());
  }

  private refresh() { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.apply(), 150); }

  /** Folders whose notes Samaya finds by path (tasks, tickets, meetings, journal): moving a note there would lose it. Projects are fine: they accept nesting. */
  private async managed(path: string): Promise<boolean> {
    const s = this.plugin.settings, app = this.plugin.app;
    const prefixes = [prefixOf(s.tasksPath), prefixOf(s.ticketsPath), meetingsPrefix(s), "Journal/"];
    for (const k of ["daily", "weekly", "monthly", "quarterly", "yearly"] as const) {
      const loc = await periodLocation(app, s, k); if (!loc) continue;
      const dir = loc.pattern ? rootOf(loc.folder) : normalizePath(loc.folder || "/");
      if (dir !== "/") prefixes.push(dir + "/");
    }
    return prefixes.some(p => path.startsWith(p));
  }

  /** The page of a folder: `Name/Name.md`. */
  private noteOf(folder: string): TFile | null {
    const f = this.plugin.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${folder.split("/").pop()}.md`));
    return f instanceof TFile ? f : null;
  }

  /** Put `child` under `source`: the parent moves into a folder of its own name (created if needed), the child follows. */
  private async nest(sourcePath: string, child: TFile) {
    const { vault, fileManager } = this.plugin.app;
    const parent = vault.getAbstractFileByPath(sourcePath);
    if (!(parent instanceof TFile) || parent.path === child.path || await this.managed(parent.path)) return;
    const to = nestPaths(parent.path, child.path);
    const free = (path: string) => !vault.getAbstractFileByPath(path);
    this.busy = true;
    try {
      const folder = vault.getAbstractFileByPath(to.folder);
      if (folder instanceof TFile) { new Notice(`Cannot nest the page: "${to.folder}" is a file.`); return; }
      if (to.parentTo !== parent.path) {
        if (!free(to.parentTo)) { new Notice(`Cannot nest the page: "${to.parentTo}" already exists.`); return; }
        if (!folder) await vault.createFolder(to.folder);
        await fileManager.renameFile(parent, to.parentTo);
      }
      if (child.path !== to.childTo) {
        if (!free(to.childTo)) { new Notice(`Cannot nest the page: "${to.childTo}" already exists.`); return; }
        await fileManager.renameFile(child, to.childTo);
      }
    } finally { this.busy = false; this.refresh(); }
  }

  /** Renaming a page renames its folder with it. */
  private async followRename(f: unknown, oldPath: string) {
    if (this.busy || !(f instanceof TFile) || f.extension !== "md") return;
    const { vault, fileManager } = this.plugin.app;
    const i = oldPath.lastIndexOf("/"), oldDir = i < 0 ? "" : oldPath.slice(0, i), oldBase = oldPath.slice(i + 1).replace(/\.md$/i, "");
    if (!oldDir || f.parent?.path !== oldDir || oldDir.split("/").pop() !== oldBase || f.basename === oldBase) return;
    const folder = vault.getAbstractFileByPath(oldDir); if (!(folder instanceof TFolder)) return;
    const j = oldDir.lastIndexOf("/"), to = (j < 0 ? "" : oldDir.slice(0, j + 1)) + f.basename;
    if (vault.getAbstractFileByPath(to)) return;
    this.busy = true;
    try { await fileManager.renameFile(folder, to); } finally { this.busy = false; this.refresh(); }
  }

  private async newSubpage(folder: string) {
    const { vault, workspace } = this.plugin.app;
    let n = 0, path = `${folder}/Untitled.md`;
    while (vault.getAbstractFileByPath(path)) path = `${folder}/Untitled ${++n}.md`;
    const file = await vault.create(path, "");
    await workspace.getLeaf(false).openFile(file);
  }

  private menu(note: TFile, e: MouseEvent) {
    const app = this.plugin.app, folder = note.parent; if (!folder) return;
    const m = new Menu();
    m.addItem(i => i.setTitle("New subpage").setIcon("file-plus").onClick(() => { safe(this.newSubpage(folder.path), "creating the subpage"); }));
    m.addSeparator();
    m.addItem(i => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => { void app.workspace.getLeaf("tab").openFile(note); }));
    m.addItem(i => i.setTitle("Rename...").setIcon("pencil").onClick(() => new TextPromptModal(this.plugin, "Rename page", v => {
      const to = normalizePath(`${note.parent?.path ?? ""}/${v.replace(/[\\/:]/g, "-")}.md`);
      if (to !== note.path) safe(app.fileManager.renameFile(note, to), "renaming the page");
    }, note.basename).open()));
    m.addItem(i => i.setTitle("Delete page and subpages").setIcon("trash").setWarning(true).onClick(() => { void app.fileManager.promptForDeletion(folder); }));
    app.workspace.trigger("file-menu", m, note, "file-explorer");
    m.showAtMouseEvent(e);
  }

  private teardown() {
    window.clearTimeout(this.timer);
    this.cleanups.forEach(f => f()); this.cleanups = [];
    this.style?.remove(); this.style = null;
  }

  /** (Re)build the explorer tweaks for the current vault; with the option off it only cleans up. */
  apply() {
    this.teardown();
    if (!this.on) return;
    const { vault, workspace } = this.plugin.app;
    const esc = (v: string) => v.replace(/["\\]/g, "\\$&");
    const css: string[] = [];
    for (const f of vault.getAllLoadedFiles()) {
      if (!(f instanceof TFolder) || f.isRoot()) continue;
      const note = this.noteOf(f.path); if (!note) continue;
      css.push(`.tree-item.nav-file:has(> .nav-file-title[data-path="${esc(note.path)}"]) { display: none; }`); // the page itself is the folder row
      if (f.children.length <= 1) css.push(`.nav-folder-title[data-path="${esc(f.path)}"] .collapse-icon { visibility: hidden; }`); // no subpages: nothing to fold
    }
    this.style = document.head.createEl("style"); this.style.textContent = css.join("\n");
    for (const leaf of workspace.getLeavesOfType("file-explorer")) {
      const el = leaf.view.containerEl;
      const page = (e: Event) => {
        const title = e.target instanceof Element ? e.target.closest<HTMLElement>(".nav-folder-title") : null;
        const path = title?.getAttribute("data-path");
        return path ? this.noteOf(path) : null;
      };
      const click = (e: MouseEvent) => {
        const note = page(e); if (!note || (e.target as Element).closest(".collapse-icon")) return; // the arrow folds, the rest opens the page
        e.stopPropagation(); e.preventDefault();
        void workspace.getLeaf(Keymap.isModEvent(e)).openFile(note);
      };
      const ctx = (e: MouseEvent) => { const note = page(e); if (!note) return; e.stopPropagation(); e.preventDefault(); this.menu(note, e); };
      el.addEventListener("click", click, true); el.addEventListener("contextmenu", ctx, true);
      const ob = new MutationObserver(() => this.markActive()); ob.observe(el, { childList: true, subtree: true });
      this.cleanups.push(() => { el.removeEventListener("click", click, true); el.removeEventListener("contextmenu", ctx, true); ob.disconnect(); });
    }
    this.cleanups.push(() => document.querySelectorAll(".samaya-nest-active").forEach(e => e.removeClass("samaya-nest-active")));
    this.markActive();
  }

  /** The folder row of the open page looks like the active file. */
  private markActive() {
    const act = this.plugin.app.workspace.getActiveFile();
    document.querySelectorAll<HTMLElement>(".nav-folder-title").forEach(t => {
      const path = t.getAttribute("data-path");
      t.toggleClass("samaya-nest-active", !!act && !!path && act.parent?.path === path && act.basename === path.split("/").pop());
    });
  }
}
