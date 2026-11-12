import { Notice, TFile, normalizePath, setIcon } from "obsidian";
import type SamayaPlugin from "./main";
import { rootOf } from "./model";
import { journalLocation } from "./journal";

interface Item { id: string; name: string; icon: string; open: () => void | Promise<void>; /** folders hidden from the file explorer while this item shows */ folders: string[]; }

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

  private base(path: string, create?: () => Promise<void>) {
    return async () => {
      if (create) await create();
      const f = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path));
      if (f instanceof TFile) await this.plugin.app.workspace.getLeaf("tab").openFile(f);
      else new Notice(`Samaya: ${path} does not exist.`);
    };
  }

  private async items(): Promise<Item[]> {
    const s = this.plugin.settings, p = this.plugin;
    const root = (path: string) => { const r = rootOf(path); return r === "/" ? null : r; };
    const join = (dir: string | null, file: string) => dir ? `${dir}/${file}` : file;
    const out: Item[] = [{ id: "planner", name: "Planner", icon: "calendar-clock", open: () => p.openPlanner(), folders: [] }];
    const tasks = root(s.tasksPath);
    out.push({ id: "tasks", name: "Tasks", icon: "check-square", open: this.base(join(tasks, "Tasks.base"), () => p.scaffold(false)), folders: tasks ? [tasks] : [] });
    if (s.journalOn) {
      const loc = await journalLocation(p.app, s);
      const jr = loc.pattern ? root(loc.folder) : normalizePath(loc.folder || "/");
      out.push({ id: "journal", name: "Journal", icon: "book-open", open: this.base("Journal/Journal.base", () => p.scaffoldJournal(false)), folders: ["Journal", ...(jr && jr !== "/" ? [jr] : [])] });
    }
    if (s.calendarOn) {
      const dir = normalizePath(s.eventNotesFolder.trim() || "Meetings");
      out.push({ id: "meetings", name: "Meetings", icon: "users", open: this.base(`${dir}/Meetings.base`), folders: [dir] });
    }
    if (s.projectsOn) {
      const dir = root(s.projectsPath.trim() || "Projects");
      out.push({ id: "projects", name: "Projects", icon: "folder-kanban", open: () => p.openProjects(), folders: dir ? [dir] : [] });
    }
    if (s.jiraOn || s.gitlabOn) {
      const dir = root(s.ticketsPath);
      out.push({ id: "tickets", name: "Tickets", icon: "ticket", open: this.base(join(dir, "Tickets.base"), () => p.scaffoldTickets(false)), folders: dir ? [dir] : [] });
    }
    return out;
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
        }
        list.prepend(box);
      };
      list.querySelectorAll(":scope > .samaya-nav-shortcuts").forEach(e => e.remove()); mount();
      const ob = new MutationObserver(mount); ob.observe(list, { childList: true }); this.observers.push(ob);
    }
  }
}
