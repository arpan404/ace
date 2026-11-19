import type { ProjectCheckoutFacts, ProjectIdentitySuggestion, WorkspaceId } from "@ace/protocol";

/** A checkout's `origin` fetch URL and its `normalizeRemoteUrl` key. */
export interface Origin {
  url: string;
  normalized: string;
}

/** What a checkout is of: every remote's key and its folder inside the work tree. */
export interface Checkout {
  remotes: string[];
  subpath: string;
}

/** Reads a checkout's `origin` and remotes, as `@ace/git`'s `GitTransfer` does. */
export interface OriginReader {
  transferOrigin(path: string): Promise<Origin | undefined>;
  checkoutFacts(path: string): Promise<Checkout | undefined>;
}

/** A registration a lookup may pick. */
export interface Candidate {
  workspaceId: WorkspaceId;
  path: string;
}

/** How many checkouts one lookup reads at once. */
const lookupWidth = 8;

/**
 * Visit `list` in order, `lookupWidth` at a time, until `visit` says stop: every item before
 * the one that stopped it has been visited. One whose read fails is skipped, not fatal.
 */
async function each<T>(list: readonly T[], visit: (item: T, index: number) => Promise<boolean>) {
  let next = 0;
  let stopped = false;
  const read = async () => {
    while (!stopped && next < list.length) {
      const index = next++;
      const item = list[index];
      if (item === undefined) return;
      if (await visit(item, index).catch(() => false)) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(lookupWidth, list.length) }, read));
}

/**
 * The registration whose `origin` is the same repository as `normalized` (a
 * `normalizeRemoteUrl` key), among every one of `projects`, which come most recently used
 * first: the first at `subpath` inside the repository ("" is its top), else the first match at
 * all. Reading stops at the first at `subpath`, once nothing before it is left to beat it.
 */
export async function sameOriginProject(
  git: OriginReader,
  projects: readonly Candidate[],
  normalized: string,
  subpath = "",
): Promise<WorkspaceId | undefined> {
  let exact = projects.length;
  let any = projects.length;
  await each(projects, async (project, index) => {
    if (index > exact) return true;
    const origin = await git.transferOrigin(project.path);
    if (origin?.normalized !== normalized) return false;
    any = Math.min(any, index);
    const facts = await git.checkoutFacts(project.path);
    if (facts?.subpath !== subpath) return false;
    exact = Math.min(exact, index);
    return true;
  });
  return projects[exact]?.workspaceId ?? projects[any]?.workspaceId;
}

/** A registration's checkout facts; a plain folder reads as one with no repository. */
export async function checkoutOf(git: OriginReader, path: string): Promise<ProjectCheckoutFacts> {
  const facts = await git.checkoutFacts(path);
  return facts ? { repository: true, ...facts } : { repository: false, remotes: [], subpath: "" };
}

/**
 * Which of `projects` may be the same logical project as a checkout with `remotes` at
 * `subpath`: one that shares any remote and sits at the same subpath, in `projects`' order. A
 * shared remote at another subpath (another folder of a monorepo) is not one.
 */
export async function identitySuggestions(
  git: OriginReader,
  projects: readonly Candidate[],
  remotes: readonly string[],
  subpath: string,
  /** Also registrations whose folder's marker names `id` (ADR 0181), read with `read`. */
  marker?: { id: string; read(path: string): Promise<string | undefined> },
): Promise<ProjectIdentitySuggestion[]> {
  const wanted = new Set(remotes);
  if (!wanted.size && !marker) return [];
  const found: { index: number; suggestion: ProjectIdentitySuggestion }[] = [];
  await each(projects, async (project, index) => {
    const [facts, named] = await Promise.all([
      wanted.size ? git.checkoutFacts(project.path) : undefined,
      marker?.read(project.path).catch(() => undefined),
    ]);
    const marked = marker !== undefined && named === marker.id;
    const shared =
      facts && facts.subpath === subpath
        ? facts.remotes.filter((remote) => wanted.has(remote))
        : [];
    if (!shared.length && !marked) return false;
    const sameRemotes =
      shared.length > 0 && shared.length === wanted.size && facts?.remotes.length === wanted.size;
    found.push({
      index,
      suggestion: {
        workspaceId: project.workspaceId,
        shared,
        sameRemotes,
        ...(marked ? { marker: true as const } : {}),
      },
    });
    return false;
  });
  return found.toSorted((a, b) => a.index - b.index).map((entry) => entry.suggestion);
}

/**
 * `origin` and remote reads kept for `ttlMs` per checkout, and shared while one is in flight,
 * so moving New thread between machines or paging suggestions asks Git once per checkout
 * rather than on every ask. A remote changed meanwhile is seen once its entry expires.
 */
export class OriginCache implements OriginReader {
  private readonly origins = new Map<string, { at: number; value: Promise<Origin | undefined> }>();
  private readonly facts = new Map<string, { at: number; value: Promise<Checkout | undefined> }>();
  private readonly git: OriginReader;
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(git: OriginReader, now: () => number, ttlMs = 30_000) {
    this.git = git;
    this.now = now;
    this.ttlMs = ttlMs;
  }
  transferOrigin(path: string): Promise<Origin | undefined> {
    return this.kept(this.origins, path, () => this.git.transferOrigin(path));
  }
  checkoutFacts(path: string): Promise<Checkout | undefined> {
    return this.kept(this.facts, path, () => this.git.checkoutFacts(path));
  }
  private kept<T>(
    entries: Map<string, { at: number; value: Promise<T> }>,
    path: string,
    read: () => Promise<T>,
  ): Promise<T> {
    const at = this.now();
    const kept = entries.get(path);
    if (kept && at - kept.at < this.ttlMs) return kept.value;
    const value = read();
    entries.set(path, { at, value });
    // A failed read isn't kept: the next one asks Git again.
    value.catch(() => {
      if (entries.get(path)?.value === value) entries.delete(path);
    });
    return value;
  }
}
