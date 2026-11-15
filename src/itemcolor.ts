// Colours of projects and tickets: one hex in the note's `color` property, picked from a fixed palette.
import { App, TFile } from "obsidian";
import { patchNote } from "./model";

export const COLOR_PROP = "color";
/** The colours a project / ticket can wear (name, hex): readable on light and dark themes. */
export const PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: "Rose", hex: "#e39aa0" }, { name: "Peach", hex: "#eba97f" }, { name: "Sand", hex: "#e3c57c" }, { name: "Lime", hex: "#b4cc7e" },
  { name: "Green", hex: "#8fc9a0" }, { name: "Teal", hex: "#84c9c0" }, { name: "Sky", hex: "#88c3df" }, { name: "Blue", hex: "#8fa8e0" },
  { name: "Lavender", hex: "#a99be0" }, { name: "Lilac", hex: "#c39be0" }, { name: "Pink", hex: "#e39bc3" }, { name: "Slate", hex: "#a3adb8" },
];
/** The brighter first palette, same order: colours saved in it are moved to the matching new one. */
const OLD_PALETTE = ["#e5484d", "#f76b15", "#e5a50a", "#8db600", "#30a46c", "#12a594", "#0d9ec4", "#3e63dd", "#6e56cf", "#a64fd1", "#d6409f", "#7b8794"];
export function upgradeColor(hex: string): string { const i = OLD_PALETTE.indexOf(hex.toLowerCase()); return i < 0 ? hex : PALETTE[i].hex; }
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
