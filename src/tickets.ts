// Jira / GitLab fetching. Pure with respect to Obsidian: HTTP is injected so it can be unit-tested.
export interface RawTicket { source: "jira" | "gitlab"; id: string; key: string; summary: string; url: string; state: string; project: string; type: string; assignee: string; description: string; }
export interface HttpResult { status: number; json: any; headers: Record<string, string>; } // eslint-disable-line @typescript-eslint/no-explicit-any
export type Http = (o: { url: string; headers?: Record<string, string> }) => Promise<HttpResult>;

export interface JiraCfg { flavor: "cloud" | "server"; url: string; email: string; token: string; jql: string; }
export interface GitlabCfg { url: string; token: string; scope: string; }

const b64 = (s: string) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s).toString("base64"));
const header = (h: Record<string, string>, name: string): string => {
  const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase()); return k ? h[k] : "";
};

/** Jira Cloud descriptions are Atlassian Document Format; flatten them to plain text. */
export function adfToText(n: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!n) return ""; if (typeof n === "string") return n;
  const kids: any[] = n.content ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const inline = () => kids.map(adfToText).join("");
  switch (n.type) {
    case "text": return n.text ?? "";
    case "hardBreak": return "\n";
    case "mention": case "emoji": return n.attrs?.text ?? n.attrs?.shortName ?? "";
    case "inlineCard": return n.attrs?.url ?? "";
    case "bulletList": return kids.map(li => "- " + adfToText(li).replace(/\n/g, "\n  ")).join("\n");
    case "orderedList": return kids.map((li, i) => `${i + 1}. ` + adfToText(li).replace(/\n/g, "\n   ")).join("\n");
    case "codeBlock": return "```\n" + inline() + "\n```";
    case "paragraph": case "heading": return inline();
    case "listItem": return kids.map(adfToText).join("\n");
    default: return kids.map(adfToText).join("\n\n");
  }
}

// a truncated result would make sync close every ticket it did not get back: fail instead
const MAX_PAGES = 20;
const TOO_MANY = `more than ${MAX_PAGES * 100} tickets match - narrow the query (JQL / scope)`;
export async function fetchJira(cfg: JiraCfg, http: Http): Promise<RawTicket[]> {
  if (!cfg.url || !cfg.token) throw new Error("Jira: base URL and token are required");
  const auth = cfg.flavor === "cloud" ? `Basic ${b64(`${cfg.email}:${cfg.token}`)}` : `Bearer ${cfg.token}`;
  const headers = { Authorization: auth, Accept: "application/json" };
  const out: RawTicket[] = [];
  const map = (i: any): RawTicket => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    source: "jira", id: i.key, key: i.key, summary: i.fields?.summary ?? "", url: `${cfg.url}/browse/${i.key}`,
    state: i.fields?.status?.name ?? "", project: i.fields?.project?.key ?? String(i.key).split("-")[0],
    type: i.fields?.issuetype?.name ?? "", assignee: i.fields?.assignee?.displayName ?? "", description: adfToText(i.fields?.description).trim(),
  });
  const fields = "summary,status,project,issuetype,assignee,description";
  if (cfg.flavor === "cloud") {
    let token = ""; let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = `jql=${encodeURIComponent(cfg.jql)}&fields=${fields}&maxResults=100` + (token ? `&nextPageToken=${encodeURIComponent(token)}` : "");
      const r = await http({ url: `${cfg.url}/rest/api/3/search/jql?${q}`, headers });
      out.push(...(r.json.issues ?? []).map(map));
      token = r.json.nextPageToken ?? ""; if (!token || r.json.isLast) { complete = true; break; }
    }
    if (!complete) throw new Error(TOO_MANY);
  } else {
    let start = 0; let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await http({ url: `${cfg.url}/rest/api/2/search?jql=${encodeURIComponent(cfg.jql)}&fields=${fields}&maxResults=100&startAt=${start}`, headers });
      const issues = r.json.issues ?? []; out.push(...issues.map(map)); start += issues.length;
      if (!issues.length || start >= (r.json.total ?? 0)) { complete = true; break; }
    }
    if (!complete) throw new Error(TOO_MANY);
  }
  return out;
}

export async function fetchGitlab(cfg: GitlabCfg, http: Http): Promise<RawTicket[]> {
  if (!cfg.url || !cfg.token) throw new Error("GitLab: base URL and token are required");
  const out: RawTicket[] = []; let page = "1";
  for (let n = 0; page; n++) {
    if (n >= MAX_PAGES) throw new Error(TOO_MANY);
    const r = await http({ url: `${cfg.url}/api/v4/issues?scope=${cfg.scope}&state=opened&per_page=100&page=${page}`, headers: { "PRIVATE-TOKEN": cfg.token } });
    for (const i of r.json as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const full: string = i.references?.full ?? `#${i.iid}`; // e.g. group/project#12
      out.push({ source: "gitlab", id: `${full}`, key: full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full, summary: i.title ?? "", url: i.web_url ?? "", state: i.state ?? "opened", project: full.split("#")[0],
        type: String(i.issue_type ?? i.type ?? "issue").toLowerCase(), assignee: (i.assignees ?? (i.assignee ? [i.assignee] : [])).map((a: any) => a.name).join(", "), description: (i.description ?? "").trim() }); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    page = header(r.headers, "x-next-page");
  }
  return out;
}
