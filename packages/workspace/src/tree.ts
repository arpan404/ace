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
    const entries = await safe.entries(dir);
    for (let start = 0; start < entries.length; start += 256) {
      aborted(options.signal);
      const paths = entries
        .slice(start, start + 256)
        .map((entry) => (dir ? `${dir}/${entry.name}` : entry.name))
        .filter((path) => !internal(path) && validRelativePath(path));
      const actualPath = (path: string) =>
        actualDir
          ? `${actualDir}/${path.slice(dir ? dir.length + 1 : 0)}`
          : path.slice(dir ? dir.length + 1 : 0);
      const ignored = await ignore.ignored(paths.map(actualPath), options.signal);
      const metadata = new Map(
        entries
          .slice(start, start + 256)
          .map((entry) => [dir ? `${dir}/${entry.name}` : entry.name, entry]),
      );
      for (const path of paths) {
        aborted(options.signal);
        if (++visited > TREE_CAP)
          throw new WorkspaceError("LIMIT_EXCEEDED", "Workspace traversal exceeds 100,000 entries");
        const hidden = ignored.has(actualPath(path));
        if (hidden && !options.includeIgnored) continue;
        try {
          const discovered = metadata.get(path);
          if (!discovered) continue;
          const resolved = discovered.type === "symlink" ? await safe.metadata(path) : undefined;
          const type = resolved?.type ?? discovered.type;
          const size = resolved?.info.size ?? discovered.info.size;
          const mtime = resolved?.info.mtimeMs ?? discovered.info.mtime;
          yield { path, type, size, mtime, ignored: hidden };
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
