# Samaya

An Obsidian plugin for planning your day: tasks as notes, timeboxing, a week board, a focus timer, work-time tracking, meetings, a journal, and Jira / GitLab tickets as notes.

Install by copying `main.js`, `manifest.json` and `styles.css` from a [release](https://github.com/scimone/samaya/releases) into `<vault>/.obsidian/plugins/samaya/`, or via BRAT using `scimone/samaya`. Open it with the **Open Samaya** command or the ribbon icon.

## What it does

- **Planner.** One page with a **Day** view (the task list next to a timeline you drag tasks onto) and a **Week** view (a board of days, plus an expanded week timeline). Tasks can be split into parts over several days; unplanned work waits in the backlog (next week, month, quarter, year, someday).
- **Guided planning.** *Plan my day* walks through Review (overdue tasks), Pick, Timebox and Check; *Plan my week* adds Tickets, Backlog and Schedule steps; *End my day* ticks off forgotten tasks and shows a day review (plan vs. reality). Each guide keeps a buffer reminder so you do not plan 100% of your time.
- **Focus timer.** Start a focus on a task; the tracked time is written to the task note (`duration_actual`, `focus_sessions`), shown on cards and in a banner.
- **Work time.** Start and end the workday, take breaks, set per-day start/finish lines and lunch; a dashboard shows balance against your weekly hours.
- **Meetings.** Calendar events are notes in a folder (the file name and frontmatter describe them); the planner shows them on the timeline and a banner counts down to the next one. A Meetings page groups recurring meetings into series.
- **Tasks, tickets, projects.** A task board, a ticket Kanban board (grouped by Jira / GitLab project), and a projects Gantt chart. Tasks link to tickets and projects.
- **Journal.** Daily, weekly, monthly, quarterly and yearly notes (your core Daily notes or Periodic Notes settings, or Samaya's own) get a navigation bar, and the guides can write sections into them (planned tasks, meetings, finished tasks, a productivity review, work times and breaks).

Everything is plain Markdown: a task is a note with frontmatter (`status`, `planned_sessions`, `duration_estimate`, `duration_actual`, `assigned_ticket`, `assigned_project`, `day_completed`, ...), so it works with search, Bases and sync.

## Commands

Plan my day / week (guided), Start shutdown ritual, Review my week, Toggle week timeline, Start workday now, Start / End break, Open work time dashboard, New task, Focus on current note's task, Convert checkbox line to task note, Assign current task note to a ticket / project, New project, Open ticket board / journal / projects, Create Samaya files.

## Development

```
npm ci
npm run dev     # watch build
npm run build   # typecheck + production bundle (main.js)
npm test        # typecheck + unit tests (test/run.mjs)
```

Releases are built by GitHub Actions when a tag equal to the `manifest.json` version is pushed.

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
