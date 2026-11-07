import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SamayaPlugin from "./main";

export interface SamayaSettings {
  tasksFolder: string; ticketsFolder: string; meetingsFolder: string; journalFolder: string; plannerFile: string;
  taskTemplate: string; meetingTemplate: string;
  icsUrls: string[]; icsRefreshMinutes: number;
  dayStartHour: number; dayEndHour: number; slotMinutes: number;
  defaultEstimate: number; capacityHours: number; shutdownTime: string; openOnStartup: boolean;
  jiraFlavor: "cloud" | "server"; jiraUrl: string; jiraEmail: string; jiraToken: string; jiraJql: string;
  gitlabUrl: string; gitlabToken: string; gitlabScope: "assigned_to_me" | "created_by_me" | "all";
  syncOnStartup: boolean;
  lunchStart: string; lunchEnd: string; weeklyHours: number; workDays: number; autoLunch: boolean;
}
export const DEFAULT_SETTINGS: SamayaSettings = {
  tasksFolder: "Tasks", ticketsFolder: "Tickets", meetingsFolder: "Meetings", journalFolder: "Journal", plannerFile: "Planner.base", taskTemplate: "", meetingTemplate: "",
  icsUrls: [], icsRefreshMinutes: 15,
  dayStartHour: 7, dayEndHour: 20, slotMinutes: 15, defaultEstimate: 30, capacityHours: 6, shutdownTime: "17:30", openOnStartup: false,
  jiraFlavor: "cloud", jiraUrl: "", jiraEmail: "", jiraToken: "",
  jiraJql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
  gitlabUrl: "https://gitlab.com", gitlabToken: "", gitlabScope: "assigned_to_me", syncOnStartup: false,
  lunchStart: "12:00", lunchEnd: "13:00", weeklyHours: 40, workDays: 5, autoLunch: true,
};

export class SamayaSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SamayaPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl: c } = this; c.empty();
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveSettings(); };
    const text = (name: string, desc: string, get: () => string, set: (v: string) => void, secret = false) =>
      new Setting(c).setName(name).setDesc(desc).addText(t => { t.setValue(get()).onChange(async v => { set(v.trim()); await save(); }); if (secret) t.inputEl.type = "password"; });
    const num = (name: string, desc: string, get: () => number, set: (v: number) => void) =>
      new Setting(c).setName(name).setDesc(desc).addText(t => t.setValue(String(get())).onChange(async v => { const n = Number(v); if (!isNaN(n) && n > 0) { set(n); await save(); } }));

    new Setting(c).setName("Folders").setHeading();
    text("Tasks folder", "One note per task.", () => s.tasksFolder, v => (s.tasksFolder = v || "Tasks"));
    text("Tickets folder", "One note per imported Jira / GitLab ticket.", () => s.ticketsFolder, v => (s.ticketsFolder = v || "Tickets"));
    text("Meetings folder", "One note per calendar meeting (named yyyy-mm-dd_title).", () => s.meetingsFolder, v => (s.meetingsFolder = v || "Meetings"));
    text("Journal folder (fallback)", "Daily notes use Settings > Daily notes (folder and date format). This folder is only used while that plugin has no settings.", () => s.journalFolder, v => (s.journalFolder = v || "Journal"));
    text("Task note template", "Path of a template note, e.g. Templates/Task. Variables: {{title}} {{date}} {{date:FORMAT}} {{time}}. A '## Subtasks' heading is added if missing. Empty = built-in.", () => s.taskTemplate, v => (s.taskTemplate = v));
    text("Meeting note template", "Path of a template note, e.g. Templates/Meeting. Variables: {{title}} {{date}} {{start}} {{end}}. Empty = built-in.", () => s.meetingTemplate, v => (s.meetingTemplate = v));
    text("Planner base file", "Base file opened by the ribbon icon.", () => s.plannerFile, v => (s.plannerFile = v || "Planner.base"));

    new Setting(c).setName("Planner").setHeading();
    num("Day start hour", "First hour on the timeboxing grid (0-23).", () => s.dayStartHour, v => (s.dayStartHour = Math.min(23, Math.floor(v))));
    num("Day end hour", "Last hour on the grid (1-24).", () => s.dayEndHour, v => (s.dayEndHour = Math.min(24, Math.floor(v))));
    num("Snap size (minutes)", "Timeboxing granularity.", () => s.slotMinutes, v => (s.slotMinutes = v));
    num("Default estimate (minutes)", "Used for new tasks and unestimated tasks dropped on the grid.", () => s.defaultEstimate, v => (s.defaultEstimate = v));
    num("Daily capacity (hours)", "Total plannable hours. Free capacity = this minus lunch break minus calendar meetings.", () => s.capacityHours, v => (s.capacityHours = v));
    text("Shutdown time", "HH:mm - a reminder to run the shutdown ritual.", () => s.shutdownTime, v => { if (/^\d{1,2}:\d{2}$/.test(v)) s.shutdownTime = v; });
    new Setting(c).setName("Open planner on startup").addToggle(t => t.setValue(s.openOnStartup).onChange(async v => { s.openOnStartup = v; await save(); }));

    new Setting(c).setName("Work time").setHeading();
    const hm = (v: string) => /^\d{1,2}:\d{2}$/.test(v);
    text("Lunch break starts", "HH:mm. Marked in the calendar and subtracted from capacity.", () => s.lunchStart, v => { if (hm(v)) s.lunchStart = v; });
    text("Lunch break ends", "HH:mm", () => s.lunchEnd, v => { if (hm(v)) s.lunchEnd = v; });
    num("Required hours per week", "Used by the work time dashboard for overtime.", () => s.weeklyHours, v => (s.weeklyHours = v));
    num("Working days per week", "Counted from Monday (5 = Mon-Fri). Work on other days is all overtime.", () => s.workDays, v => (s.workDays = Math.min(7, Math.round(v))));
    new Setting(c).setName("Add the default lunch automatically").setDesc("When you end the day without having logged a lunch break, subtract the lunch window above.").addToggle(t => t.setValue(s.autoLunch).onChange(async v => { s.autoLunch = v; await save(); }));

    new Setting(c).setName("Calendar overlay (ICS, read-only)").setHeading();
    new Setting(c).setName("ICS URLs").setDesc("One per line (Google Calendar 'secret address in iCal format', Outlook, ...).")
      .addTextArea(t => { t.setValue(s.icsUrls.join("\n")).onChange(async v => { s.icsUrls = v.split("\n").map(x => x.trim().replace(/^webcal:/, "https:")).filter(Boolean); await save(); this.plugin.ics.clear(); }); t.inputEl.rows = 3; t.inputEl.cols = 40; });
    num("ICS refresh (minutes)", "How long fetched calendars are cached.", () => s.icsRefreshMinutes, v => (s.icsRefreshMinutes = v));

    new Setting(c).setName("Jira").setHeading();
    c.createEl("p", { cls: "setting-item-description", text: "Tokens are stored unencrypted in this plugin's data.json inside the vault. Don't sync that file to places you don't trust." });
    new Setting(c).setName("Flavor").setDesc("Cloud: email + API token. Server/Data Center: personal access token.")
      .addDropdown(d => d.addOption("cloud", "Jira Cloud").addOption("server", "Server / Data Center").setValue(s.jiraFlavor).onChange(async v => { s.jiraFlavor = v as SamayaSettings["jiraFlavor"]; await save(); }));
    text("Base URL", "e.g. https://yourteam.atlassian.net", () => s.jiraUrl, v => (s.jiraUrl = v.replace(/\/+$/, "")));
    text("Email", "Jira Cloud only.", () => s.jiraEmail, v => (s.jiraEmail = v));
    text("API token", "", () => s.jiraToken, v => (s.jiraToken = v), true);
    text("JQL", "Which issues to import.", () => s.jiraJql, v => (s.jiraJql = v));

    new Setting(c).setName("GitLab").setHeading();
    text("Base URL", "https://gitlab.com or your self-hosted URL.", () => s.gitlabUrl, v => (s.gitlabUrl = v.replace(/\/+$/, "")));
    text("Personal access token", "Scope: read_api.", () => s.gitlabToken, v => (s.gitlabToken = v), true);
    new Setting(c).setName("Issues to import").addDropdown(d => d.addOption("assigned_to_me", "Assigned to me").addOption("created_by_me", "Created by me").addOption("all", "All I can see").setValue(s.gitlabScope).onChange(async v => { s.gitlabScope = v as SamayaSettings["gitlabScope"]; await save(); }));

    new Setting(c).setName("Sync").setHeading();
    new Setting(c).setName("Sync tickets on startup").addToggle(t => t.setValue(s.syncOnStartup).onChange(async v => { s.syncOnStartup = v; await save(); }));
    new Setting(c).setName("Sync now").addButton(b => b.setButtonText("Sync Jira + GitLab").setCta().onClick(async () => { new Notice("Syncing tickets..."); await this.plugin.syncTickets(); }));
  }
}
