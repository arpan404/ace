import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { BrowserActionError } from "./action-error.ts";
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}
/** Real paths fence symlinks. Only regular files are sent to Chromium, never directories/devices. */
export async function uploadPaths(options: {
  files: string[];
  roots: string[];
  policy?: (paths: string[]) => Promise<boolean>;
  artifactAllowed?: (path: string) => boolean | Promise<boolean>;
  check(): void;
}): Promise<string[]> {
  const roots = await Promise.all(options.roots.map((root) => realpath(root)));
  const paths = await Promise.all(
    options.files.map((file) => realpath(resolve(roots[0] ?? ".", file))),
  );
  const outside: string[] = [];
  for (const path of paths)
    if (!roots.some((root) => within(root, path)) && !(await options.artifactAllowed?.(path)))
      outside.push(path);
  if (outside.length && !(await options.policy?.(outside))) throw new BrowserActionError("denied");
  let bytes = 0;
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile()) throw new BrowserActionError("invalid_arguments");
    bytes += info.size;
    if (bytes > 64 * 1024 * 1024) throw new BrowserActionError("limit");
    if ((await realpath(path)) !== path) throw new BrowserActionError("denied");
  }
  options.check();
  return paths;
}
