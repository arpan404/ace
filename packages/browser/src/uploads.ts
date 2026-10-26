import { realpath, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { BrowserActionError } from "./action-error.ts";

type PathApi = Pick<typeof nodePath, "isAbsolute" | "relative" | "sep">;

/** Whether `path` is `root` or below it. `pathApi` is injectable so win32 rules test on any OS. */
export function pathWithin(root: string, path: string, pathApi: PathApi = nodePath): boolean {
  const rel = pathApi.relative(root, path);
  if (rel === "") return true;
  return !pathApi.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + pathApi.sep);
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
    options.files.map((file) => realpath(nodePath.resolve(roots[0] ?? ".", file))),
  );
  const outside: string[] = [];
  for (const path of paths)
    if (!roots.some((root) => pathWithin(root, path)) && !(await options.artifactAllowed?.(path)))
      outside.push(path);
  if (outside.length && options.policy && !(await options.policy(outside)))
    throw new BrowserActionError("denied");
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
