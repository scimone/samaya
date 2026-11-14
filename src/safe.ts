import { Notice } from "obsidian";

/** Run a promise nobody awaits (a click handler, a drop): a failure is logged and shown instead of vanishing as an unhandled rejection. */
export function safe(p: Promise<unknown>, what: string): void {
  p.catch(e => {
    console.warn(`Samaya: ${what} failed`, e);
    new Notice(`Samaya: ${what} failed - ${e instanceof Error ? e.message : String(e)}`);
  });
}
