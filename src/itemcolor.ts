// Colours of projects and tickets: one hex in the note's `color` property, picked from a fixed palette.
import { App, TFile } from "obsidian";
import { patchNote } from "./model";

export const COLOR_PROP = "color";
/** The colours a project / ticket can wear (name, hex): readable on light and dark themes. */
export const PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: "Red", hex: "#e5484d" }, { name: "Orange", hex: "#f76b15" }, { name: "Amber", hex: "#e5a50a" }, { name: "Lime", hex: "#8db600" },
  { name: "Green", hex: "#30a46c" }, { name: "Teal", hex: "#12a594" }, { name: "Cyan", hex: "#0d9ec4" }, { name: "Blue", hex: "#3e63dd" },
  { name: "Indigo", hex: "#6e56cf" }, { name: "Purple", hex: "#a64fd1" }, { name: "Pink", hex: "#d6409f" }, { name: "Slate", hex: "#7b8794" },
];
const HEX = /^#[0-9a-f]{6}$/i;

/** The colour a note carries ("" = none). */
export function noteColor(app: App, file: TFile): string {
  const v = String(app.metadataCache.getFileCache(file)?.frontmatter?.[COLOR_PROP] ?? "").trim();
  return HEX.test(v) ? v.toLowerCase() : "";
}
/** A palette colour: random among the ones `used` the least, so new items rarely repeat a colour. */
export function randomColor(used: string[] = [], rnd: () => number = Math.random): string {
  const count = (h: string) => used.filter(u => u.toLowerCase() === h).length;
  const min = Math.min(...PALETTE.map(c => count(c.hex)));
  const pool = PALETTE.filter(c => count(c.hex) === min);
  return pool[Math.floor(rnd() * pool.length)].hex;
}
export async function writeNoteColor(app: App, file: TFile, hex: string): Promise<void> { await patchNote(app, file, { [COLOR_PROP]: hex || null }); }
/** Paint an element with a colour (CSS: `.has-pc` + `--pc`); no colour leaves its default look. */
export function tint<T extends HTMLElement>(el: T, hex: string): T {
  if (hex) { el.style.setProperty("--pc", hex); el.addClass("has-pc"); }
  return el;
}

// ---- ticket projects: one colour per Jira / GitLab project, kept in the settings
let persist: () => Promise<void> = async () => {};
/** The plugin registers how settings are saved, so colour helpers need no plugin reference. */
export function setColorPersist(fn: () => Promise<void>) { persist = fn; }
export const savePersisted = () => persist();
/** Colour of a ticket project ("" = none). */
export function ticketProjectColor(s: { ticketProjectColors: Record<string, string> }, key: string): string {
  const v = key ? s.ticketProjectColors[key] : ""; return v && HEX.test(v) ? v.toLowerCase() : "";
}
export async function setTicketProjectColor(s: { ticketProjectColors: Record<string, string> }, key: string, hex: string): Promise<void> {
  if (!key) return; s.ticketProjectColors[key] = hex; await persist();
}
