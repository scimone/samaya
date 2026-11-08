# Samaya

An Obsidian plugin for planning your day: tasks, timeboxing, meetings, work time, and Jira / GitLab tickets as notes.

Install by copying `main.js`, `manifest.json` and `styles.css` from a [release](https://github.com/scimone/samaya/releases) into `<vault>/.obsidian/plugins/samaya/`, or via BRAT using `scimone/samaya`.

## Jira / GitLab tickets

Configure Jira and/or GitLab in the plugin settings, then run **Sync Jira and GitLab tickets**. Every open ticket becomes a note; tickets that disappear from the results (resolved, reassigned) are marked `closed`.

### Ticket variables

Three settings can use ticket variables, always written in double braces, e.g. `{{TASK_ID}}`:

| Variable | Value |
| --- | --- |
| `{{TASK_ID}}` | Ticket key, e.g. `OPS-12` (Jira) or `proj#12` (GitLab) |
| `{{TASK_TITLE}}` | Summary / title |
| `{{TASK_TYPE}}` | Issue type, e.g. `Bug`, `Story` (GitLab: `issue`, `incident`, ...) |
| `{{TASK_STATUS}}` | Jira status name, or GitLab state (`opened`) |
| `{{TASK_ASSIGNEE}}` | Assignee display name(s), comma-separated |
| `{{TASK_URL}}` | Link to the ticket |
| `{{TASK_DESCRIPTION}}` | Description as plain text (Jira) or Markdown (GitLab) |
| `{{TASK_PROJECT}}` | Jira project key, or GitLab `group/project` |

Two extra variables are available: `{{TASK_SOURCE}}` (`Jira` / `GitLab`) and `{{TASK_TITLE_SLUG}}` (the title as a lowercase slug, max 60 characters). Unknown variables are left as they are.

| Setting | Variables allowed | Default |
| --- | --- | --- |
| **Tickets path** | all (in practice `TASK_STATUS`, `TASK_PROJECT`, `TASK_TYPE`, `TASK_ASSIGNEE`) | `[Tickets]` |
| **Ticket file name** | all | `{{TASK_ID}}_{{TASK_TITLE_SLUG}}` |
| **Ticket note template** | all, plus `{{date}}` and `{{date:FORMAT}}` | `# {{TASK_TITLE}}` and a link to the ticket |

- **Tickets path** is a folder pattern. Date parts use [moment.js format](https://momentjs.com/docs/#/displaying/format); literal text goes in `[brackets]`. Example: `[Tickets]/[Jira]/{{TASK_STATUS}}` puts a ticket with status "In Progress" in `Tickets/Jira/In Progress/`. Values are made safe for folder names (an empty value becomes `None`). If the path contains `{{TASK_STATUS}}`, a note moves to the new folder when the ticket's status changes.
- **Ticket file name** has no `.md`; characters not allowed in file names are replaced. If a name is taken, ` 2`, ` 3`, ... is appended.
- **Ticket note template** is the path of a template note in your vault, e.g. `Templates/Ticket`. Empty uses the built-in template. The template is only used when a note is created; later syncs update properties, not the body.

### Ticket properties

Sync writes these properties to each ticket note (overwritten on every sync):

| Property | Value |
| --- | --- |
| `source` | `jira`, `gitlab` or `manual` |
| `id` | `TASK_ID` (also stored in `aliases`, so `[[OPS-12]]` links resolve) |
| `title` | `TASK_TITLE` |
| `project` | `TASK_PROJECT` |
| `status` | `TASK_STATUS` (`closed` once the ticket no longer appears in sync) |
| `type` | `TASK_TYPE` |
| `assignee` | `TASK_ASSIGNEE` |
| `url` | `TASK_URL`; sync matches existing notes by this, so don't edit it |
| `aliases` | `[TASK_ID]` |

Notes created by version 0.1.3 or earlier (`key`, `summary`, `state`, `issue_type`, `type: ticket`) are migrated on the next sync.
