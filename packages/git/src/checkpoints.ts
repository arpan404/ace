import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOutput } from "./cli.ts";
import { nul } from "./parse.ts";
import { Repository } from "./repository.ts";
import { GitError, type Checkpoint } from "./types.ts";

export function checkpointPrefix(threadId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) {
    throw new GitError(
      "invalid_argument",
      "threadId must contain only letters, digits, underscores or hyphens",
    );
  }
  return `refs/ace/checkpoints/${threadId}/`;
}

export function checkpointIdentity(id: string): { threadId: string; sequence: number } {
  const match = /^refs\/ace\/checkpoints\/([A-Za-z0-9_-]+)\/([1-9]\d*)$/.exec(id);
  if (!match || !Number.isSafeInteger(Number(match[2]))) {
    throw new GitError("checkpoint_not_found", `Invalid checkpoint id: ${id}`);
  }
  return { threadId: match[1]!, sequence: Number(match[2]) };
}

export async function withIndex<T>(
  operation: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ace-git-index-"));
  try {
    return await operation({ GIT_INDEX_FILE: join(directory, "index") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function snapshot(repository: Repository, root: string): Promise<string> {
  const { cli } = repository;
  return withIndex(async (env) => {
    const head = await cli.call(root, ["rev-parse", "--verify", "HEAD^{tree}"], {
      allowFailure: true,
    });
    await cli.call(
      root,
      ["read-tree", ...(head.exitCode === 0 ? [textOutput(head)] : ["--empty"])],
      { write: true, env },
    );
    // Seed tracked additions from the real index, including force-added ignored files.
    // HEAD entries stay seeded even when the user staged their deletion.
    // --stage omits assume-unchanged/skip-worktree flags and handles unresolved merges.
    const tracked = await cli.call(root, ["ls-files", "--stage", "-z"]);
    const seed = nul(tracked.stdout).map((entry) => {
      const tab = entry.indexOf("\t");
      return entry.slice(0, tab).replace(/ [123]$/, " 0") + entry.slice(tab);
    });
    await cli.call(root, ["update-index", "-z", "--index-info"], {
      write: true,
      env,
      input: seed.length ? seed.join("\0") + "\0" : "",
    });
    await cli.call(root, ["-c", "core.sparseCheckout=false", "add", "--all", "--", "."], {
      write: true,
      env,
    });
    const tree = textOutput(await cli.call(root, ["write-tree"], { write: true, env }));
    await assertNoGitlinks(repository, root, tree);
    return tree;
  });
}

export async function assertNoGitlinks(
  repository: Repository,
  root: string,
  tree: string,
): Promise<void> {
  const entries = nul((await repository.cli.call(root, ["ls-tree", "-r", "-z", tree])).stdout);
  if (entries.some((entry) => entry.startsWith("160000 "))) {
    throw new GitError(
      "unsupported_repository",
      "Full working-tree snapshots cannot include submodules or embedded repositories",
    );
  }
}

interface Ref {
  id: string;
  sha: string;
  sequence: number;
}

export async function checkpointRefs(
  repository: Repository,
  root: string,
  threadId: string,
): Promise<Ref[]> {
  const prefix = checkpointPrefix(threadId);
  const output = textOutput(
    await repository.cli.call(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      prefix,
    ]),
  );
  if (!output) return [];
  return output
    .split("\n")
    .map((record) => {
      const [id, sha] = record.split("\0");
      const { sequence } = checkpointIdentity(id!);
      return { id: id!, sha: sha!, sequence };
    })
    .toSorted((a, b) => a.sequence - b.sequence);
}

export async function createCheckpoint(
  repository: Repository,
  root: string,
  threadId: string,
  label: string,
): Promise<Checkpoint> {
  const prefix = checkpointPrefix(threadId);
  const tree = await snapshot(repository, root);
  const createdAt = new Date().toISOString();
  const metadata = JSON.stringify({ format: "ace-checkpoint-v1", threadId, label, createdAt });
  // Fixed local identity makes checkpoints work without user.name/email or signing setup.
  const sha = textOutput(
    await repository.cli.call(root, ["-c", "commit.gpgSign=false", "commit-tree", tree], {
      write: true,
      input: `${metadata}\n`,
      env: {
        GIT_AUTHOR_NAME: "ace",
        GIT_AUTHOR_EMAIL: "checkpoints@ace.local",
        GIT_COMMITTER_NAME: "ace",
        GIT_COMMITTER_EMAIL: "checkpoints@ace.local",
      },
    }),
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    const refs = await checkpointRefs(repository, root, threadId);
    const sequence = (refs.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence))
      throw new GitError("git_failed", "Checkpoint sequence exhausted");
    const id = `${prefix}${sequence}`;
    const result = await repository.cli.call(
      root,
      ["update-ref", id, sha, "0".repeat(sha.length)],
      { write: true, allowFailure: true },
    );
    if (result.exitCode === 0) return { id, sha, tree, threadId, sequence, label, createdAt };
    const collision = await repository.cli.call(root, ["show-ref", "--verify", "--quiet", id], {
      allowFailure: true,
    });
    if (collision.exitCode !== 0) throw new GitError("git_failed", result.stderr);
  }
  throw new GitError("git_failed", "Checkpoint refs changed repeatedly; retry the operation");
}

export async function readCheckpoint(
  repository: Repository,
  root: string,
  id: string,
  pinnedSha?: string,
): Promise<Checkpoint> {
  const { threadId, sequence } = checkpointIdentity(id);
  const commit = await repository.cli.call(
    root,
    ["rev-parse", "--verify", "--end-of-options", `${pinnedSha ?? id}^{commit}`],
    { allowFailure: true },
  );
  if (commit.exitCode !== 0)
    throw new GitError("checkpoint_not_found", `Checkpoint not found: ${id}`);
  const sha = textOutput(commit);
  const output = await repository.cli.call(root, [
    "show",
    "--no-show-signature",
    "-s",
    "--format=%T%x00%B",
    sha,
  ]);
  const [tree, message] = nul(output.stdout);
  let data: unknown;
  try {
    data = JSON.parse(message ?? "");
  } catch {
    data = null;
  }
  if (
    !data ||
    typeof data !== "object" ||
    !("format" in data) ||
    data.format !== "ace-checkpoint-v1" ||
    !("threadId" in data) ||
    data.threadId !== threadId ||
    !("label" in data) ||
    typeof data.label !== "string" ||
    !("createdAt" in data) ||
    typeof data.createdAt !== "string"
  ) {
    throw new GitError("checkpoint_not_found", `Ref does not contain an ace checkpoint: ${id}`);
  }
  return { id, sha, tree: tree!, threadId, sequence, label: data.label, createdAt: data.createdAt };
}

export async function deleteCheckpoints(
  repository: Repository,
  root: string,
  threadId: string,
): Promise<{ deleted: number }> {
  const refs = await checkpointRefs(repository, root, threadId);
  if (!refs.length) return { deleted: 0 };
  const input = [
    "start",
    ...refs.map((ref) => `delete ${ref.id} ${ref.sha}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  await repository.cli.call(root, ["update-ref", "--stdin"], { write: true, input });
  return { deleted: refs.length };
}
