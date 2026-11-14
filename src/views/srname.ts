let srId = 0;
/**
 * Give an element its accessible name without a tooltip: a visually hidden text, referenced by aria-labelledby. (An aria-label is shown by Obsidian as a tooltip,
 * and a container's aria-label also pops up over every child, on top of the children's own tooltips.) `host` holds the hidden text when `el` cannot (an svg).
 */
export function srName(el: Element, label: string, host: HTMLElement = el as HTMLElement) {
  const sr = host.createSpan({ cls: "samaya-sr", text: label }); sr.id = `samaya-sr-${++srId}`;
  el.setAttribute("aria-labelledby", sr.id);
}
