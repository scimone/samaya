import { FileSystemAdapter, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type SamayaPlugin from "./main";
import { rootOf } from "./model";
import { journalLocation } from "./journal";
import { TextPromptModal } from "./modals";
import { createProject } from "./projects";

interface Item { id: string; name: string; icon: string; open: () => void | Promise<void>; /** folders hidden from the file explorer while this item shows */ folders: string[];
  /** the folder behind the item (for search, copy path, show in system explorer); none for the planner */ folder?: string; /** "New xx" entry of the context menu */ create?: { label: string; run: () => void }; }

/** Shortcuts (Planner, Tasks, Journal, ...) at the top of the file explorer; the folders behind them are hidden. */
export class NavShortcuts {
  private style: HTMLStyleElement | null = null;
  private observers: MutationObserver[] = [];
  private run = 0;
  constructor(private plugin: SamayaPlugin) {}

  init() {
    const { workspace } = this.plugin.app;
    const refresh = () => { void this.apply(); };
    this.plugin.registerEvent(workspace.on("layout-change", refresh));
    this.plugin.register(this.plugin.bus.on(refresh));
    this.plugin.registerEvent(this.plugin.app.vault.on("create", f => { if (f instanceof TFile && f.extension === "base") refresh(); }));
    this.plugin.register(() => this.teardown());
  }

  /** Open a base: focus the tab that already shows it, else show it in the current tab. */
  private base(path: string, create?: () => Promise<void>) {
    return async () => {
      if (create) await create();
      const ws = this.plugin.app.workspace, p = normalizePath(path);
      const f = this.plugin.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) { new Notice(`Samaya: ${path} does not exist.`); return; }
      let found: WorkspaceLeaf | null = null;
      ws.iterateAllLeaves(l => { if (!found && l.getRoot() === ws.rootSplit && (l.getViewState().state as { file?: string } | undefined)?.file === p) found = l; });
      if (found) { await ws.revealLeaf(found); ws.setActiveLeaf(found, { focus: true }); }
      else await ws.getLeaf(false).openFile(f);
    };
  }

  private async items(): Promise<Item[]> {
    const s = this.plugin.settings, p = this.plugin;
    const root = (path: string) => { const r = rootOf(path); return r === "/" ? null : r; };
    const join = (dir: string | null, file: string) => dir ? `${dir}/${file}` : file;
    const out: Item[] = [{ id: "planner", name: "Planner", icon: "calendar-clock", open: () => p.openPlanner(true), folders: [] }];
    const tasks = root(s.tasksPath);
    out.push({ id: "tasks", name: "Tasks", icon: "check-square", open: this.base(join(tasks, "Tasks.base"), () => p.scaffold(false)), folders: tasks ? [tasks] : [], folder: tasks ?? "/", create: { label: "New task", run: () => p.quickAdd() } });
    if (s.journalOn) {
      const loc = await journalLocation(p.app, s);
      const jr = loc.pattern ? root(loc.folder) : normalizePath(loc.folder || "/");
      out.push({ id: "journal", name: "Journal", icon: "book-open", open: this.base("Journal/Journal.base", () => p.scaffoldJournal(false)), folders: ["Journal", ...(jr && jr !== "/" ? [jr] : [])], folder: jr && jr !== "/" ? jr : "Journal" });
    }
    if (s.calendarOn) {
      const dir = normalizePath(s.eventNotesFolder.trim() || "Meetings");
      out.push({ id: "meetings", name: "Meetings", icon: "calendar-days", open: this.base(`${dir}/Meetings.base`), folders: [dir], folder: dir });
    }
    if (s.projectsOn) {
      const dir = normalizePath(s.projectsPath.trim() || "Projects"); // a plain folder, not a path pattern
      out.push({ id: "projects", name: "Projects", icon: "folder-kanban", open: this.base(s.projectsBase.trim() || `${dir}/Projects.base`, () => p.scaffoldProjects(false)), folders: [dir], folder: dir, create: { label: "New project", run: () => new TextPromptModal(p, "New project name", n => { void createProject(p.app, s, n).then(() => p.bus.emit()); }).open() } });
    }
    const tdir = root(s.ticketsPath);
    if (s.jiraOn || s.gitlabOn || p.app.vault.getAbstractFileByPath(normalizePath(join(tdir, "Tickets.base")))) { // also while only the ticket notes exist
      const dir = tdir;
      out.push({ id: "tickets", name: "Tickets", icon: "ticket", open: this.base(join(dir, "Tickets.base"), () => p.scaffoldTickets(false)), folders: dir ? [dir] : [], folder: dir ?? "/" });
    }
    return out;
  }

  /** Right-click menu of a shortcut, like the one of a folder in the file explorer. */
  private menu(it: Item, e: MouseEvent) {
    if (!it.folder) return;
    const folder = it.folder, app = this.plugin.app, m = new Menu();
    if (it.create) m.addItem(i => i.setTitle(it.create!.label).setIcon("edit").onClick(it.create!.run));
    if (it.id !== "planner") m.addItem(i => i.setTitle(`Search in ${it.name.toLowerCase()}`).setIcon("search").onClick(() => {
      const search = (app as unknown as { internalPlugins?: { getPluginById(id: string): { instance?: { openGlobalSearch?(q: string): void } } | undefined } }).internalPlugins?.getPluginById("global-search")?.instance;
      if (folder === "/") search?.openGlobalSearch?.(""); else search?.openGlobalSearch?.(`path:"${folder}" `);
    }));
    m.addSeparator();
    const copy = (text: string) => { void navigator.clipboard.writeText(text); new Notice("Path copied"); };
    const ad = app.vault.adapter;
    m.addItem(i => i.setTitle("Copy path from vault folder").setIcon("copy").onClick(() => copy(folder)));
    if (ad instanceof FileSystemAdapter) {
      const root = ad.getBasePath().replace(/[\\/]+$/, "");
      m.addItem(i => i.setTitle("Copy path from system root").setIcon("copy").onClick(() => copy(folder === "/" ? root : `${root}/${folder}`)));
      m.addSeparator();
      m.addItem(i => i.setTitle("Show in system explorer").setIcon("arrow-up-right").onClick(() => { (app as unknown as { showInFolder(p: string): void }).showInFolder(folder === "/" ? "" : folder); }));
    }
    m.showAtMouseEvent(e);
  }

  private teardown() {
    this.run++;
    this.observers.forEach(o => o.disconnect()); this.observers = [];
    this.style?.remove(); this.style = null;
    document.querySelectorAll(".samaya-nav-shortcuts").forEach(e => e.remove());
  }

  /** (Re)build everything for the current settings; with the option off it only cleans up. */
  async apply() {
    const me = ++this.run;
    if (!this.plugin.settings.navigationOn) { this.teardown(); return; }
    const items = await this.items();
    if (me !== this.run) return;
    // hide the folders behind the shortcuts
    const esc = (v: string) => v.replace(/["\\]/g, "\\$&");
    const css = items.flatMap(i => i.folders).map(f => `.tree-item.nav-folder:has(> .nav-folder-title[data-path="${esc(f)}"]) { display: none; }`).join("\n");
    if (!this.style) this.style = document.head.createEl("style");
    this.style.textContent = css;
    // shortcuts at the top of every file explorer
    this.observers.forEach(o => o.disconnect()); this.observers = [];
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("file-explorer")) {
      const list = leaf.view.containerEl.querySelector<HTMLElement>(".nav-files-container"); if (!list) continue;
      const mount = () => {
        if (list.querySelector(":scope > .samaya-nav-shortcuts")) return;
        const box = createDiv("samaya-nav-shortcuts");
        for (const it of items) {
          const row = box.createDiv("tree-item nav-file").createDiv({ cls: "tree-item-self nav-file-title is-clickable samaya-nav-item", attr: { "aria-label": it.name, "data-samaya-nav": it.id } });
          setIcon(row.createDiv("tree-item-icon samaya-nav-icon"), it.icon);
          row.createDiv({ cls: "tree-item-inner nav-file-title-content", text: it.name });
          row.addEventListener("click", () => { void it.open(); });
          row.addEventListener("contextmenu", e => { e.preventDefault(); this.menu(it, e); });
        }
        list.prepend(box);
      };
      list.querySelectorAll(":scope > .samaya-nav-shortcuts").forEach(e => e.remove()); mount();
      const ob = new MutationObserver(mount); ob.observe(list, { childList: true }); this.observers.push(ob);
    }
  }
}
