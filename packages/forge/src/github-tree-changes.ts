import { z } from "zod";
import { ForgeError } from "./errors.ts";
import type { GhApi } from "./http.ts";

const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const Commit = z.looseObject({ sha, tree: z.looseObject({ sha }) });
const Tree = z.looseObject({
  sha,
  truncated: z.boolean().optional(),
  tree: z
    .array(
      z.looseObject({
        path: z.string().min(1).max(4_096),
        type: z.string().max(16),
        sha,
      }),
    )
    .max(100_000),
});
type Entry = z.infer<typeof Tree>["tree"][number];
/** A file, link or submodule: anything but a folder. */
const blob = (entry: Entry | undefined) => entry && entry.type !== "tree";
const treeOf = (entry: Entry | undefined) => (entry?.type === "tree" ? entry.sha : undefined);

export interface TreeChange {
  path: string;
  status: "added" | "removed" | "modified";
}
/** The most paths and tree reads one comparison may take before it stops, incomplete. */
const maxChanges = 100_000;
const maxReads = 3_000;
const parallel = 6;

/** Two reads at once; neither outlives the call, even when the other fails first. */
export async function both<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  await Promise.allSettled([a, b]);
  return [await a, await b];
}

/** Paths in git's order (bytewise), which is how GitHub lists a pull request's files. */
export const gitOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * The files that differ between two commits, found by reading only the trees whose ids differ:
 * a few reads for a deep change, never the whole repository. Renames read as a removal and an
 * addition. `complete` is false when the walk stopped at a bound or GitHub cut a tree short.
 */
export async function treeChanges(
  api: GhApi,
  root: string,
  base: string,
  head: string,
  signal: AbortSignal,
): Promise<{ changes: TreeChange[]; complete: boolean }> {
  const commit = async (ref: string) => {
    const parsed = Commit.safeParse((await api.request(`${root}/git/commits/${ref}`, signal)).body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    return parsed.data.tree.sha;
  };
  const [baseTree, headTree] = await both(commit(base), commit(head));
  const changes: TreeChange[] = [];
  let reads = 0;
  let complete = true;
  const tree = async (id: string, recursive: boolean) => {
    reads++;
    const parsed = Tree.safeParse(
      (await api.request(`${root}/git/trees/${id}${recursive ? "?recursive=1" : ""}`, signal)).body,
    );
    if (!parsed.success || parsed.data.sha !== id) throw new ForgeError("invalid_data");
    if (parsed.data.truncated) complete = false;
    return parsed.data.tree;
  };
  const add = (path: string, status: TreeChange["status"]) => {
    if (changes.length < maxChanges) changes.push({ path, status });
    else complete = false;
  };
  type Pair = { prefix: string; base?: string | undefined; head?: string | undefined };
  const queue: Pair[] = [{ prefix: "", base: baseTree, head: headTree }];
  // Everything under a tree only one side has, read in one recursive listing.
  const oneSided = async (prefix: string, id: string, status: "added" | "removed") => {
    for (const entry of await tree(id, true))
      if (entry.type !== "tree") add(`${prefix}${entry.path}`, status);
  };
  const visit = async (pair: Pair) => {
    if (!pair.base || !pair.head) {
      const id = pair.base ?? pair.head;
      if (id) await oneSided(pair.prefix, id, pair.base ? "removed" : "added");
      return;
    }
    const [before, after] = await both(tree(pair.base, false), tree(pair.head, false));
    const old = new Map(before.map((entry) => [entry.path, entry]));
    const seen = new Set<string>();
    for (const entry of after) {
      seen.add(entry.path);
      const previous = old.get(entry.path);
      if (previous?.sha === entry.sha && previous.type === entry.type) continue;
      const path = `${pair.prefix}${entry.path}`;
      if (treeOf(previous) || treeOf(entry))
        queue.push({ prefix: `${path}/`, base: treeOf(previous), head: treeOf(entry) });
      if (blob(previous) && blob(entry)) add(path, "modified");
      else if (blob(previous)) add(path, "removed");
      else if (blob(entry)) add(path, "added");
    }
    for (const entry of before) {
      if (seen.has(entry.path)) continue;
      const path = `${pair.prefix}${entry.path}`;
      if (entry.type === "tree") queue.push({ prefix: `${path}/`, base: entry.sha });
      else add(path, "removed");
    }
  };
  const running = new Set<Promise<void>>();
  // The first failure stops new reads; the ones in flight finish before it is thrown.
  let failure: { error: unknown } | undefined;
  while (queue.length || running.size) {
    while (queue.length && running.size < parallel) {
      if (reads >= maxReads) {
        complete = false;
        queue.length = 0;
        break;
      }
      const pair = queue.shift();
      if (!pair) break;
      const work: Promise<void> = visit(pair)
        .catch((error: unknown) => {
          failure ??= { error };
          queue.length = 0;
        })
        .finally(() => running.delete(work));
      running.add(work);
    }
    if (running.size) await Promise.race(running);
  }
  if (failure) throw failure.error;
  changes.sort((a, b) => gitOrder(a.path, b.path));
  return { changes, complete };
}
