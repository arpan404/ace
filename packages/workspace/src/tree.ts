import { relative, sep } from "node:path";
import type { SafeRoot } from "./safety.ts";
import { internal, transient, validRelativePath } from "./safety.ts";
import type { GitIgnore } from "./ignore.ts";
import { aborted, TREE_CAP, WorkspaceError, type Entry } from "./types.ts";

/** Deterministic preorder; directories are not followed through symlinks. */
export async function* tree(
  safe: SafeRoot,
  ignore: GitIgnore,
  options: {
    dir: string;
    depth: number;
    includeIgnored: boolean;
    signal?: AbortSignal;
  },
): AsyncGenerator<Entry> {
  let visited = 0;
  async function* descend(dir: string, depth: number): AsyncGenerator<Entry> {
    aborted(options.signal);
    const actualDir = relative(safe.root, await safe.resolve(dir))
      .split(sep)
      .join("/");
    if (internal(actualDir)) return;
    const names = await safe.names(dir);
    for (let start = 0; start < names.length; start += 256) {
      aborted(options.signal);
      const paths = names
        .slice(start, start + 256)
        .map((name) => (dir ? `${dir}/${name}` : name))
        .filter((path) => !internal(path) && validRelativePath(path));
      const actualPath = (path: string) =>
        actualDir
          ? `${actualDir}/${path.slice(dir ? dir.length + 1 : 0)}`
          : path.slice(dir ? dir.length + 1 : 0);
      const ignored = await ignore.ignored(paths.map(actualPath), options.signal);
      for (const path of paths) {
        aborted(options.signal);
        if (++visited > TREE_CAP)
          throw new WorkspaceError("LIMIT_EXCEEDED", "Workspace traversal exceeds 100,000 entries");
        const hidden = ignored.has(actualPath(path));
        if (hidden && !options.includeIgnored) continue;
        try {
          const { info, type } = await safe.metadata(path);
          yield { path, type, size: info.size, mtime: info.mtimeMs, ignored: hidden };
          if (type === "directory" && depth > 1) yield* descend(path, depth - 1);
        } catch (error) {
          if (!transient(error)) throw error;
        }
      }
    }
  }
  try {
    yield* descend(options.dir, options.depth);
  } finally {
    await safe.resolve("");
  }
}
