# Samaya

An Obsidian plugin for planning your day: tasks, timeboxing, meetings, work time, and Jira / GitLab tickets as notes.

Install by copying `main.js`, `manifest.json` and `styles.css` from a [release](https://github.com/scimone/samaya/releases) into `<vault>/.obsidian/plugins/samaya/`, or via BRAT using `scimone/samaya`.

## Jira / GitLab tickets

Configure Jira and/or GitLab in the plugin settings, then run **Sync Jira and GitLab tickets**. Every open ticket becomes a note; tickets that disappear from the results (resolved, reassigned) are marked `closed`.

### Ticket variables

Three settings can use ticket variables, always written in double braces, e.g. `{{TICKET_ID}}`:

| Variable | Value |
| --- | --- |
| `{{TICKET_ID}}` | Ticket key, e.g. `OPS-12` (Jira) or `proj#12` (GitLab) |
| `{{TICKET_TITLE}}` | Summary / title |
| `{{TICKET_TYPE}}` | Issue type, e.g. `Bug`, `Story` (GitLab: `issue`, `incident`, ...) |
| `{{TICKET_STATUS}}` | Jira status name, or GitLab state (`opened`) |
| `{{TICKET_ASSIGNEE}}` | Assignee display name(s), comma-separated |
| `{{TICKET_URL}}` | Link to the ticket |
| `{{TICKET_DESCRIPTION}}` | Description as plain text (Jira) or Markdown (GitLab) |
| `{{TICKET_PROJECT}}` | Jira project key, or GitLab `group/project` |
| `{{TICKET_SOURCE}}` | Where the ticket comes from: `JIRA` or `GITLAB` |

One extra variable is available: `{{TICKET_TITLE_SLUG}}` (the title as a lowercase slug, max 60 characters). Unknown variables are left as they are. Older `{{TASK_*}}` names still work in templates.

| Setting | Variables allowed | Default |
| --- | --- | --- |
| **Tickets path** | all (in practice `TICKET_SOURCE`, `TICKET_STATUS`, `TICKET_PROJECT`, `TICKET_TYPE`, `TICKET_ASSIGNEE`) | `[Tickets]/{{TICKET_SOURCE}}/{{TICKET_STATUS}}` |
| **Ticket file name** | all | `{{TICKET_ID}}_{{TICKET_TITLE_SLUG}}` |
| **Ticket note template** | all, plus `{{date}}` and `{{date:FORMAT}}` | `# {{TICKET_TITLE}}` and a link to the ticket |

- **Tickets path** is a folder pattern. Date parts use [moment.js format](https://momentjs.com/docs/#/displaying/format); literal text goes in `[brackets]`. Example: the default `[Tickets]/{{TICKET_SOURCE}}/{{TICKET_STATUS}}` puts a Jira ticket with status "In Progress" in `Tickets/JIRA/In Progress/`. Values are made safe for folder names (an empty value becomes `None`). If the path contains `{{TICKET_STATUS}}`, a note moves to the new folder when the ticket's status changes.
- **Ticket file name** has no `.md`; characters not allowed in file names are replaced. If a name is taken, ` 2`, ` 3`, ... is appended.
- **Ticket note template** is the path of a template note in your vault, e.g. `Templates/Ticket`. Empty uses the built-in template. The template is only used when a note is created; later syncs update properties, not the body.

### Ticket properties

Sync writes these properties to each ticket note (overwritten on every sync):

| Property | Value |
| --- | --- |
| `source` | `jira` or `gitlab` |
| `id` | `TICKET_ID` (also stored in `aliases`, so `[[OPS-12]]` links resolve) |
| `title` | `TICKET_TITLE` |
| `project` | `TICKET_PROJECT` |
| `status` | `TICKET_STATUS` (`closed` once the ticket no longer appears in sync) |
| `type` | `TICKET_TYPE` |
| `assignee` | `TICKET_ASSIGNEE` |
| `url` | `TICKET_URL`; sync matches existing notes by this, so don't edit it |
| `aliases` | `[TICKET_ID]` |

Notes created by version 0.1.3 or earlier (`key`, `summary`, `state`, `issue_type`, `type: ticket`) are migrated on the next sync.
