import { App, TFile } from "obsidian";
import type { CalendarEvent } from "./eventnotes";

/** The note of a calendar event. Every event is an existing note (see eventnotes.ts), so this only resolves it. */
export async function ensureMeetingNote(app: App, ev: CalendarEvent): Promise<TFile> {
  const f = ev.notePath ? app.vault.getAbstractFileByPath(ev.notePath) : null;
  if (f instanceof TFile) return f;
  throw new Error("Samaya: event has no note");
}
