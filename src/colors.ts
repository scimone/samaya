import type { SamayaSettings } from "./settings";

/** Resolve any CSS colour (including `var(--x)`) to "#rrggbb", or "" when it cannot be resolved. */
export function resolveColor(css: string): string {
  const el = document.body.createDiv(); el.style.color = css; el.style.display = "none";
  const rgb = getComputedStyle(el).color; el.remove();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb); if (!m) return "";
  return "#" + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, "0")).join("");
}
/** Black or white, whichever reads better on `hex`. */
export function onColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16); if (!/^#[0-9a-f]{6}$/i.test(hex)) return "";
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.4 ? "#000000" : "#ffffff";
}
const HEX = /^#[0-9a-f]{6}$/i;
/** Publish the task and meeting colours as CSS variables on <body>; an empty setting falls back to the theme (accent for tasks, cyan for meetings). */
export function applyColors(s: Pick<SamayaSettings, "taskColor" | "meetingColor">) {
  const st = document.body.style;
  if (HEX.test(s.taskColor)) { st.setProperty("--samaya-task", s.taskColor); st.setProperty("--samaya-task-on", onColor(s.taskColor)); }
  else { st.removeProperty("--samaya-task"); st.removeProperty("--samaya-task-on"); }
  if (HEX.test(s.meetingColor)) st.setProperty("--samaya-meeting", s.meetingColor); else st.removeProperty("--samaya-meeting");
}
export function clearColors() { for (const k of ["--samaya-task", "--samaya-task-on", "--samaya-meeting"]) document.body.style.removeProperty(k); }
