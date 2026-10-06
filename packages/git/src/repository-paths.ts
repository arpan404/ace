import { isAbsolute, relative, sep } from "node:path";

export function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
