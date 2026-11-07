import { Notice, normalizePath, requestUrl } from "obsidian";
import type SamayaPlugin from "./main";
import { Http, RawTicket, fetchGitlab, fetchJira } from "./tickets";
import { allTickets, patchTask } from "./model";
import { safeFileName } from "./util";

const http: Http = async o => {
  const r = await requestUrl({ url: o.url, headers: o.headers });
  return { status: r.status, json: r.json, headers: r.headers };
};

export async function syncTickets(plugin: SamayaPlugin, only?: "jira" | "gitlab"): Promise<void> {
  const s = plugin.settings; const app = plugin.app;
  const jobs: Array<["jira" | "gitlab", () => Promise<RawTicket[]>]> = [];
  if ((!only || only === "jira") && s.jiraUrl && s.jiraToken) jobs.push(["jira", () => fetchJira({ flavor: s.jiraFlavor, url: s.jiraUrl, email: s.jiraEmail, token: s.jiraToken, jql: s.jiraJql }, http)]);
  if ((!only || only === "gitlab") && s.gitlabUrl && s.gitlabToken) jobs.push(["gitlab", () => fetchGitlab({ url: s.gitlabUrl, token: s.gitlabToken, scope: s.gitlabScope }, http)]);
  if (!jobs.length) { new Notice("Samaya: configure Jira and/or GitLab in the plugin settings first."); return; }

  const folder = normalizePath(s.ticketsFolder);
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);

  for (const [source, run] of jobs) {
    try {
      const tickets = await run();
      const existing = new Map(allTickets(app, s).filter(t => t.source === source).map(t => [t.id, t]));
      let created = 0, closed = 0;
      for (const t of tickets) {
        const fm = { type: "ticket", source, id: t.id, key: t.key, summary: t.summary, url: t.url, state: t.state, project: t.project };
        const hit = existing.get(t.id);
        if (hit) { await patchTask(app, hit.file, fm); existing.delete(t.id); continue; }
        let path = `${folder}/${safeFileName(t.key)}.md`; let i = 2;
        while (app.vault.getAbstractFileByPath(path)) path = `${folder}/${safeFileName(t.key)} ${i++}.md`;
        const f = await app.vault.create(path, `# ${t.summary}\n\n[Open in ${source === "jira" ? "Jira" : "GitLab"}](${t.url})\n`);
        await patchTask(app, f, fm); created++;
      }
      // tickets we imported earlier that no longer appear are resolved / reassigned
      for (const gone of existing.values()) if (gone.state !== "closed") { await patchTask(app, gone.file, { state: "closed" }); closed++; }
      new Notice(`${source === "jira" ? "Jira" : "GitLab"}: ${tickets.length} open tickets (${created} new, ${closed} closed)`);
    } catch (e) {
      console.error("Samaya sync failed", e);
      new Notice(`Samaya: ${source} sync failed - ${(e as Error).message}`);
    }
  }
}
