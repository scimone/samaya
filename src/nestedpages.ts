import { Keymap, Menu, Notice, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import type SamayaPlugin from "./main";
import { safe } from "./safe";
import { TextPromptModal } from "./modals";
import { nestPaths } from "./nestpaths";
import { prefixOf, rootOf } from "./model";
import { meetingsPrefix } from "./links";
import { periodLocation } from "./journal";
import { projectsPrefix } from "./projects";

/** The folder of a page: the note sits in a folder of its own name (`Foo/Foo.md`). */
export function pageFolder(file: TFile): TFolder | null {
  const p = file.parent; return p && !p.isRoot() && p.name === file.basename ? p : null;
}
const pageOf = (folder: TFolder): TFile | null => { const f = folder.children.find(c => c instanceof TFile && c.extension === "md" && c.basename === folder.name); return f instanceof TFile ? f : null; };
/** What the delete menu of a page offers: its subpages (a subpage with subpages of its own is deleted with its folder), and itself when it is a subpage. */
export function pageTree(file: TFile): { subpages: { file: TFile; target: TAbstractFile; kids: boolean }[]; self: TAbstractFile | null } {
  const own = pageFolder(file), subpages: { file: TFile; target: TAbstractFile; kids: boolean }[] = [];
  for (const c of own?.children ?? []) {
    if (c === file) continue;
    if (c instanceof TFile && c.extension === "md") subpages.push({ file: c, target: c, kids: false });
    else if (c instanceof TFolder) { const pg = pageOf(c); if (pg) subpages.push({ file: pg, target: c, kids: c.children.length > 1 }); }
  }
  subpages.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
  const container = own ? own.parent : file.parent; // the page this one lives under, if any
  const parent = container && !container.isRoot() ? pageOf(container) : null;
  return { subpages, self: parent && parent !== file ? (own ?? file) : null };
}

/** Notion-like pages: a page created from an unresolved link inside another page is nested under it. Under the hood the parent
 *  lives in a folder of its own name (with its children); the file explorer shows that folder as the parent page with a toggle. */
export class NestedPages {
  private style: HTMLStyleElement | null = null;
  private cleanups: (() => void)[] = [];
  private pending: { source: string; at: number } | null = null;
  private busy = false;
  private run = 0;
  /** folders whose notes Samaya finds by path (see managed); kept for the checks that cannot wait */
  private prefixes: string[] = [];
  /** folders shown as a page in the explorer */
  private pageSet = new Set<string>();
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

  private refresh() { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.apply(); }, 150); }

  /** Folders whose notes Samaya finds by path (tasks, tickets, meetings, journal): moving a note there would lose it. Projects are fine: they accept nesting. */
  private async managedPrefixes(): Promise<string[]> {
    const s = this.plugin.settings, app = this.plugin.app;
    const prefixes = [prefixOf(s.tasksPath), prefixOf(s.ticketsPath), meetingsPrefix(s), "Journal/"];
    for (const k of ["daily", "weekly", "monthly", "quarterly", "yearly"] as const) {
      const loc = await periodLocation(app, s, k); if (!loc) continue;
      const dir = loc.pattern ? rootOf(loc.folder) : normalizePath(loc.folder || "/");
      if (dir !== "/") prefixes.push(dir + "/");
    }
    return this.prefixes = prefixes;
  }
  private async managed(path: string): Promise<boolean> { return (await this.managedPrefixes()).some(p => path.startsWith(p)); }
  /** As `managed`, from the folders found at the last refresh. */
  isManaged(path: string): boolean { return this.prefixes.some(p => path.startsWith(p)); }
  /** Whether the side pane's delete menu applies to this note. */
  usable(file: TFile): boolean {
    if (file.path.startsWith(projectsPrefix(this.plugin.settings))) return true; // subpages of a project: always, nested pages on or off
    return this.on && !this.isManaged(file.path);
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
    if (this.busy || !(f instanceof TFile) || f.extension !== "md" || this.isManaged(f.path)) return;
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
  async apply() {
    const me = ++this.run;
    this.teardown();
    if (!this.on) return;
    await this.managedPrefixes(); if (me !== this.run) return;
    const { vault, workspace } = this.plugin.app;
    const esc = (v: string) => v.replace(/["\\]/g, "\\$&");
    const css: string[] = []; this.pageSet.clear();
    for (const f of vault.getAllLoadedFiles()) {
      if (!(f instanceof TFolder) || f.isRoot()) continue;
      const note = this.noteOf(f.path); if (!note || this.isManaged(note.path)) continue;
      this.pageSet.add(f.path);
      css.push(`.tree-item.nav-file:has(> .nav-file-title[data-path="${esc(note.path)}"]) { display: none; }`); // the page itself is the folder row
      if (f.children.length <= 1) css.push(`.nav-folder-title[data-path="${esc(f.path)}"] .collapse-icon { visibility: hidden; }`); // no subpages: nothing to fold
    }
    this.style = document.head.createEl("style"); this.style.textContent = css.join("\n");
    for (const leaf of workspace.getLeavesOfType("file-explorer")) {
      const el = leaf.view.containerEl;
      const page = (e: Event) => {
        const title = e.target instanceof Element ? e.target.closest<HTMLElement>(".nav-folder-title") : null;
        const path = title?.getAttribute("data-path");
        return path && this.pageSet.has(path) ? this.noteOf(path) : null;
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
