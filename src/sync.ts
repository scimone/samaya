import { Notice, normalizePath, requestUrl } from "obsidian";
import type SamayaPlugin from "./main";
import { Http, RawTicket, fetchGitlab, fetchJira } from "./tickets";
import { LEGACY_TICKET_PROPS, allTickets, createTicketNote, ticketProps, patchNote, relocateTicket, varsOfRaw, varsOfTicket } from "./model";

const http: Http = async o => {
  const r = await requestUrl({ url: o.url, headers: o.headers });
  return { status: r.status, json: r.json, headers: r.headers };
};

export async function syncTickets(plugin: SamayaPlugin, only?: "jira" | "gitlab"): Promise<void> {
  const s = plugin.settings; const app = plugin.app;
  const jobs: Array<["jira" | "gitlab", () => Promise<RawTicket[]>]> = [];
  if (!s.ticketsOn) return;
  if ((!only || only === "jira") && s.jiraOn && s.jiraUrl && s.jiraToken) jobs.push(["jira", () => fetchJira({ flavor: s.jiraFlavor, url: s.jiraUrl, email: s.jiraEmail, token: s.jiraToken, jql: s.jiraJql }, http)]);
  if ((!only || only === "gitlab") && s.gitlabOn && s.gitlabUrl && s.gitlabToken) jobs.push(["gitlab", () => fetchGitlab({ url: s.gitlabUrl, token: s.gitlabToken, scope: s.gitlabScope }, http)]);
  if (!jobs.length) { new Notice("Samaya: enable and configure Jira and/or GitLab in the plugin settings first."); return; }

  const byStatus = s.ticketsPath.includes("TICKET_STATUS");

  for (const [source, run] of jobs) {
    try {
      const tickets = await run();
      const existing = new Map(allTickets(app, s).filter(t => t.source === source).map(t => [t.url, t]));
      let created = 0, closed = 0;
      for (const t of tickets) {
        const fm = { ...ticketProps(source, varsOfRaw(t)), ...LEGACY_TICKET_PROPS };
        const hit = existing.get(t.url);
        if (hit) {
          await patchNote(app, hit.file, fm); existing.delete(t.url);
          if (byStatus && hit.state !== t.state) await relocateTicket(app, s, hit, varsOfRaw(t)); // keep status folders in step
          continue;
        }
        const f = await createTicketNote(app, s, varsOfRaw(t));
        await patchNote(app, f, fm); created++;
      }
      // tickets we imported earlier that no longer appear are resolved / reassigned
      for (const gone of existing.values()) if (gone.state !== "closed") {
        await patchNote(app, gone.file, { status: "closed" }); closed++;
        if (byStatus) await relocateTicket(app, s, gone, { ...varsOfTicket(gone), status: "closed" });
      }
      new Notice(`${source === "jira" ? "Jira" : "GitLab"}: ${tickets.length} open tickets (${created} new, ${closed} closed)`);
    } catch (e) {
      console.error("Samaya sync failed", e);
      new Notice(`Samaya: ${source} sync failed - ${(e as Error).message}`);
    }
  }
}
