import { textOutput } from "./cli.ts";
import { hash, refSchema } from "./decode.ts";
import { longWriteTimeoutMs } from "./deadlines.ts";
import { parseIndex } from "./parse-index.ts";
import type { Repository } from "./repository.ts";
import { withSnapshotIndex } from "./snapshot-index.ts";
import { GitError } from "./types.ts";

/** Transfer commits carry ace's own identity, never the person's `user.name` or signing. */
export async function transferIdentity(repository: Repository): Promise<Record<string, string>> {
  const at = (await repository.now()).toISOString();
  return {
    GIT_AUTHOR_NAME: "ace",
    GIT_AUTHOR_EMAIL: "transfers@ace.local",
    GIT_COMMITTER_NAME: "ace",
    GIT_COMMITTER_EMAIL: "transfers@ace.local",
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  };
}

export function transferRef(ref: string): string {
  if (!ref.startsWith("refs/") || !refSchema.safeParse(ref).success)
    throw new GitError("invalid_ref", `Invalid ref: ${ref}`);
  return ref;
}

export async function headCommit(
  repository: Repository,
  root: string,
): Promise<string | undefined> {
  const head = await repository.cli.call(
    root,
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    {
      allowFailure: true,
    },
  );
  return head.exitCode === 0 ? hash(textOutput(head)) : undefined;
}

/**
 * The checkout's uncommitted state (tracked edits, deletions, untracked non-ignored files) as a
 * commit on HEAD, stored at `ref`. The work happens in a temporary index seeded like a
 * checkpoint snapshot, so the person's checkout and index are untouched. Repositories nested in
 * the checkout, and linked worktrees inside it, are other checkouts and are not captured;
 * tracked submodules travel as the commit they have checked out. Undefined when nothing changed.
 */
export async function captureChanges(
  repository: Repository,
  root: string,
  options: { ref: string; message?: string | undefined },
): Promise<{ commit: string; head: string | undefined } | undefined> {
  const ref = transferRef(options.ref);
  const { cli } = repository;
  const head = await headCommit(repository, root);
  const tree = await withSnapshotIndex(repository, root, async (env, seeded) => {
    await cli.call(root, ["add", "--all", "--", ":/"], {
      write: true,
      env,
      timeoutMs: longWriteTimeoutMs,
    });
    const tracked = new Set(seeded.filter((entry) => entry.mode === "160000").map((e) => e.path));
    const embedded = parseIndex(
      (await cli.call(root, ["ls-files", "--stage", "-z"], { env })).stdout,
    )
      .filter((entry) => entry.mode === "160000" && !tracked.has(entry.path))
      .map((entry) => entry.path);
    if (embedded.length)
      await cli.call(root, ["update-index", "--force-remove", "-z", "--stdin"], {
        write: true,
        env,
        input: embedded.join("\0") + "\0",
      });
    return hash(textOutput(await cli.call(root, ["write-tree"], { write: true, env })));
  });
  const base = head
    ? hash(textOutput(await cli.call(root, ["rev-parse", "--verify", `${head}^{tree}`])))
    : hash(
        textOutput(await cli.call(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" })),
      );
  if (tree === base) return undefined;
  const commit = hash(
    textOutput(
      await cli.call(
        root,
        ["-c", "commit.gpgSign=false", "commit-tree", tree, ...(head ? ["-p", head] : [])],
        {
          write: true,
          input: `${options.message?.trim() || "Uncommitted changes"}\n`,
          env: await transferIdentity(repository),
        },
      ),
    ),
  );
  await cli.call(root, ["update-ref", ref, commit], { write: true });
  return { commit, head };
}
