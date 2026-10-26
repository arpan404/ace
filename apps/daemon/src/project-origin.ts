import type { WorkspaceId } from "@ace/protocol";

/** A checkout's `origin` fetch URL and its `normalizeRemoteUrl` key. */
export interface Origin {
  url: string;
  normalized: string;
}

/** Reads a checkout's `origin`, as `@ace/git`'s `GitTransfer.transferOrigin` does. */
export interface OriginReader {
  transferOrigin(path: string): Promise<Origin | undefined>;
}

/** The most projects one lookup reads `origin` for. */
const lookupLimit = 64;
/** How many checkouts one lookup reads at once. */
const lookupWidth = 8;

/**
 * The first of `projects` (in their order) whose `origin` is the same repository as
 * `normalized` (a `normalizeRemoteUrl` key). Checkouts are read several at a time, and reading
 * stops once nothing earlier is left to beat a match. One whose origin can't be read is
 * skipped, not fatal.
 */
export async function sameOriginProject(
  git: OriginReader,
  projects: readonly { workspaceId: WorkspaceId; path: string }[],
  normalized: string,
): Promise<WorkspaceId | undefined> {
  const list = projects.slice(0, lookupLimit);
  let next = 0;
  let found = list.length;
  const read = async () => {
    while (next < found) {
      const index = next++;
      const project = list[index];
      if (!project) return;
      const origin = await git.transferOrigin(project.path).catch(() => undefined);
      if (origin?.normalized === normalized) found = Math.min(found, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lookupWidth, list.length) }, read));
  return list[found]?.workspaceId;
}

/**
 * `origin` reads kept for `ttlMs` per checkout, and shared while one is in flight, so moving
 * New thread between machines asks Git once per checkout rather than on every move. A remote
 * changed meanwhile is seen once its entry expires.
 */
export class OriginCache implements OriginReader {
  private readonly entries = new Map<string, { at: number; origin: Promise<Origin | undefined> }>();
  private readonly git: OriginReader;
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(git: OriginReader, now: () => number, ttlMs = 30_000) {
    this.git = git;
    this.now = now;
    this.ttlMs = ttlMs;
  }
  transferOrigin(path: string): Promise<Origin | undefined> {
    const at = this.now();
    const kept = this.entries.get(path);
    if (kept && at - kept.at < this.ttlMs) return kept.origin;
    const origin = this.git.transferOrigin(path);
    this.entries.set(path, { at, origin });
    // A failed read isn't kept: the next one asks Git again.
    origin.catch(() => {
      if (this.entries.get(path)?.origin === origin) this.entries.delete(path);
    });
    return origin;
  }
}
