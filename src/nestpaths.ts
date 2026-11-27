/** Where a parent page and a new child page end up: the parent lives in a folder of its own name, the child next to it. */
export function nestPaths(parent: string, child: string): { folder: string; parentTo: string; childTo: string } {
  const split = (p: string) => { const i = p.lastIndexOf("/"); return { dir: i < 0 ? "" : p.slice(0, i), name: p.slice(i + 1) }; };
  const pa = split(parent), ch = split(child);
  const base = pa.name.replace(/\.md$/i, "");
  const inOwn = pa.dir.split("/").pop() === base; // already the page of its folder
  const folder = inOwn ? pa.dir : (pa.dir ? pa.dir + "/" : "") + base;
  return { folder, parentTo: inOwn ? parent : `${folder}/${pa.name}`, childTo: `${folder}/${ch.name}` };
}
