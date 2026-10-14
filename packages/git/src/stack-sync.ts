import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { textOutput } from "./cli.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

const objectId = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
const branchName = z
  .string()
  .min(1)
  .max(1024)
  .refine((name) => !name.startsWith("-"));
const replays = z
  .array(z.object({ branch: branchName, reviewed: objectId, current: objectId }))
  .max(100)
  .refine((list) => new Set(list.map((layer) => layer.branch)).size === list.length);
const heads = z
  .array(z.object({ branch: branchName, head: objectId }))
  .min(1)
  .max(100)
  .refine((list) => new Set(list.map((layer) => layer.branch)).size === list.length);

/** A stack layer that gains the collaborator commits `reviewed..current` on top of its local head. */
export type LayerReplay = { branch: string; reviewed: string; current: string };
/**
 * `replayed`: every layer carries its collaborator commits, and the lowest of them is checked
 * out so the layers above it can be restacked. `conflict`: Git stopped while replaying onto
 * `branch`; `remaining` layers (bottom-up) have not been started.
 */
export type StackReplayResult =
  | { state: "replayed" }
  | { state: "conflict"; branch: string; remaining: LayerReplay[] };
export type StackReplayOptions = {
  worktree: string;
  /** Moved layers, bottom-up. */
  layers: readonly LayerReplay[];
  signal?: AbortSignal;
  /** Runs once every precondition passed, immediately before the first branch changes. */
  beforeDispatch?: () => void;
};

// Replaying the person's reviewed commits runs no repository hooks; their commits already did.
const noHooks = ["-c", "core.hooksPath=/dev/null"];

/**
 * Bring collaborator commits into locally rebased layers. Each layer's new GitHub head must
 * contain the reviewed revision (no force-push) and add no merge commits, so every commit is
 * replayed as it is; already-applied changes stay as empty commits instead of being dropped.
 */
export async function replayStackLayers(
  repository: Repository,
  options: StackReplayOptions,
): Promise<StackReplayResult> {
  const layers = replays.min(1).parse(options.layers);
  const root = await repository.root(options.worktree);
  return repository.serial(root, async () => {
    await assertReady(repository, root);
    for (const layer of layers) {
      for (const revision of [`refs/heads/${layer.branch}`, layer.reviewed, layer.current]) {
        const exists = await repository.cli.call(
          root,
          ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
          { allowFailure: true },
        );
        if (exists.exitCode !== 0)
          throw new GitError("invalid_ref", `${layer.branch}: a revision is not in this checkout`);
      }
      const descends = await repository.cli.call(
        root,
        ["merge-base", "--is-ancestor", layer.reviewed, layer.current],
        { allowFailure: true },
      );
      if (descends.exitCode === 1)
        throw new GitError(
          "head_moved",
          `${layer.branch} was rewritten on GitHub: its head no longer contains the reviewed revision`,
        );
      if (descends.exitCode !== 0) throw new GitError("git_failed", "Could not compare revisions");
      const merges = textOutput(
        await repository.cli.call(root, [
          "rev-list",
          "--merges",
          "--count",
          `${layer.reviewed}..${layer.current}`,
        ]),
      );
      if (merges !== "0")
        throw new GitError(
          "invalid_ref",
          `${layer.branch} gained merge commits on GitHub; bring them in with gh stack`,
        );
    }
    options.beforeDispatch?.();
    return replay(repository, root, layers, options.signal);
  });
}

/** Commit the resolved replay, then replay the layers that had not started. */
export async function continueStackReplay(
  repository: Repository,
  options: { worktree: string; remaining: readonly LayerReplay[]; signal?: AbortSignal },
): Promise<StackReplayResult> {
  const remaining = replays.parse(options.remaining);
  const root = await repository.root(options.worktree);
  return repository.serial(root, async () => {
    if (await picking(repository, root)) {
      const status = await repository.status(root);
      if (status.conflicted.length)
        throw new GitError("conflicts", "Resolve and stage every conflicted file first");
      const resumed = await repository.cli.call(root, [...noHooks, "cherry-pick", "--continue"], {
        write: true,
        allowFailure: true,
        env: { GIT_EDITOR: "true" },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (resumed.exitCode !== 0) {
        if (await picking(repository, root))
          return { state: "conflict", branch: await currentBranch(repository, root), remaining };
        throw new GitError("git_failed", "Git could not continue replaying collaborator commits");
      }
    }
    return replay(repository, root, remaining, options.signal);
  });
}

/** Stop any replay and put every layer back at its recorded head, then check out `current`. */
export async function restoreStackBranches(
  repository: Repository,
  options: {
    worktree: string;
    heads: readonly { branch: string; head: string }[];
    current: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  const recorded = heads.parse(options.heads);
  const current = branchName.parse(options.current);
  const root = await repository.root(options.worktree);
  await repository.serial(root, async () => {
    const signal = options.signal ? { signal: options.signal } : {};
    if (await picking(repository, root))
      await repository.cli.call(root, [...noHooks, "cherry-pick", "--abort"], {
        write: true,
        ...signal,
      });
    const status = await repository.status(root);
    if (status.conflicted.length || status.staged.length || status.unstaged.length)
      throw new GitError("dirty_worktree", "Commit or discard local changes before aborting");
    // Detach first so moving the checked-out branch never leaves its files out of step.
    await repository.cli.call(root, [...noHooks, "switch", "--detach"], { write: true, ...signal });
    for (const layer of recorded)
      await repository.cli.call(
        root,
        ["update-ref", "--end-of-options", `refs/heads/${layer.branch}`, layer.head],
        { write: true, ...signal },
      );
    await repository.cli.call(root, [...noHooks, "switch", "--no-guess", "--", current], {
      write: true,
      ...signal,
    });
  });
}

/** Top-down, so the lowest moved layer ends checked out for the restack above it. */
async function replay(
  repository: Repository,
  root: string,
  layers: readonly LayerReplay[],
  signal: AbortSignal | undefined,
): Promise<StackReplayResult> {
  const order = layers.toReversed();
  for (const [index, layer] of order.entries()) {
    const options = { write: true, ...(signal ? { signal } : {}) };
    await repository.cli.call(root, [...noHooks, "switch", "--no-guess", "--", layer.branch], {
      ...options,
    });
    const picked = await repository.cli.call(
      root,
      [
        ...noHooks,
        "cherry-pick",
        "--allow-empty",
        "--keep-redundant-commits",
        "--end-of-options",
        `${layer.reviewed}..${layer.current}`,
      ],
      { ...options, allowFailure: true, env: { GIT_EDITOR: "true" } },
    );
    if (picked.exitCode === 0) continue;
    if (await picking(repository, root))
      return {
        state: "conflict",
        branch: layer.branch,
        remaining: order.slice(index + 1).toReversed(),
      };
    throw new GitError(
      "git_failed",
      `Git could not replay collaborator commits onto ${layer.branch}`,
    );
  }
  return { state: "replayed" };
}

async function assertReady(repository: Repository, root: string) {
  if (await picking(repository, root))
    throw new GitError("conflicts", "Finish or abort the cherry-pick in progress first");
  const status = await repository.status(root);
  if (status.conflicted.length || status.staged.length || status.unstaged.length)
    throw new GitError("dirty_worktree", "Commit or discard local changes first");
}

async function picking(repository: Repository, root: string): Promise<boolean> {
  const head = await repository.cli.call(
    root,
    ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"],
    { allowFailure: true },
  );
  if (head.exitCode === 0) return true;
  const path = textOutput(
    await repository.cli.call(root, ["rev-parse", "--git-path", "sequencer"]),
  );
  try {
    await access(isAbsolute(path) ? path : join(root, path));
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(repository: Repository, root: string): Promise<string> {
  return textOutput(await repository.cli.call(root, ["branch", "--show-current"]));
}
