import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ThreadId } from "@ace/protocol";

/** The Git directory of the checkout holding `cwd`: `.git` itself, or where a `.git` file points. */
export async function gitDirectory(cwd: string): Promise<string | undefined> {
  let directory = cwd;
  for (let depth = 0; depth < 32; depth++) {
    const candidate = join(directory, ".git");
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
      const text = (await readFile(candidate, "utf8")).slice(0, 8192);
      const pointer = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
      if (!pointer) return undefined;
      return isAbsolute(pointer) ? pointer : resolve(directory, pointer);
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
  return undefined;
}

/**
 * A cheap stamp of what a commit, checkout, reset or `git add` changes: HEAD, the index and the
 * HEAD reflog. Reading it spawns no Git and does work independent of history size.
 */
export async function headStamp(cwd: string): Promise<string | undefined> {
  const dir = await gitDirectory(cwd);
  if (!dir) return undefined;
  const parts = await Promise.all(
    ["HEAD", "index", join("logs", "HEAD")].map((name) =>
      stat(join(dir, name)).then(
        (info) => `${info.mtimeMs}:${info.size}`,
        () => "-",
      ),
    ),
  );
  return parts.join("|");
}

/**
 * Commits made in a thread's terminal produce no thread or file events. Threads with an open
 * terminal are probed every few seconds; a changed stamp refreshes their details at once.
 */
export class HeadWatch {
  private stamps = new Map<ThreadId, string>();
  private probe: (id: ThreadId) => Promise<string | undefined>;
  constructor(probe: (id: ThreadId) => Promise<string | undefined>) {
    this.probe = probe;
  }
  /** The threads among `ids` whose checkout metadata changed since the last check. */
  async changed(ids: readonly ThreadId[]): Promise<ThreadId[]> {
    const live = new Set(ids);
    for (const id of this.stamps.keys()) if (!live.has(id)) this.stamps.delete(id);
    const moved: ThreadId[] = [];
    for (const id of ids) {
      const stamp = await this.probe(id).catch(() => undefined);
      if (stamp === undefined) continue;
      const previous = this.stamps.get(id);
      this.stamps.set(id, stamp);
      if (previous !== undefined && previous !== stamp) moved.push(id);
    }
    return moved;
  }
}
