import { z } from "zod";
import { flattenNested, nestedPaths, ownedChildren, type SnapshotOwnership } from "./nested.ts";
import { textOutput } from "./cli.ts";
import { decode, hash, malformed, nul, pathSchema } from "./decode.ts";
import {
  checkpoint,
  checkpointIdentity,
  checkpointPrefix,
  parseCommits,
  type ParsedCommit,
} from "./checkpoint-metadata.ts";
import { checkpointRefs, counterRef } from "./checkpoint-numbers.ts";
import { parseIndex, parseTree } from "./parse-index.ts";
import { Repository } from "./repository.ts";
import { withSnapshotIndex } from "./snapshot-index.ts";
import { GitError, type Checkpoint } from "./types.ts";

export { withIndex } from "./temporary-index.ts";

export async function snapshot(
  repository: Repository,
  root: string,
  ownership?: SnapshotOwnership,
): Promise<string> {
  const { cli } = repository;
  return withSnapshotIndex(repository, root, async (env, tracked) => {
    const nested = ownership
      ? ownedChildren(ownership, root).map((child) => child.path)
      : await nestedPaths(repository, root, tracked, env);
    const gitlinks = tracked.filter((entry) => entry.mode === "160000");
    if (gitlinks.length)
      await cli.call(root, ["update-index", "--force-remove", "-z", "--stdin"], {
        write: true,
        env,
        input: gitlinks.map((entry) => entry.path).join("\0") + "\0",
      });
    // Git can reject an excluded, ignored directory as an explicit ignored
    // pathspec. Select only this root's tracked/unignored files instead; child
    // repositories retain exclusive filter and index ownership.
    const paths = nested.length
      ? [
          ...new Set(
            nul(
              (
                await cli.call(
                  root,
                  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                  { env },
                )
              ).stdout,
            ),
          ),
        ]
          .map((path) =>
            decode(pathSchema, path.endsWith("/") ? path.slice(0, -1) : path, "snapshot path"),
          )
          .filter((path) => !nested.some((child) => path === child || path.startsWith(child + "/")))
          .map((path) => `:(literal)${path}`)
      : ["."];
    if (paths.length)
      await cli.call(root, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        write: true,
        env,
        input: paths.join("\0") + "\0",
      });
    await flattenNested(
      repository,
      root,
      nested,
      env,
      (repo, child) => snapshot(repo, child, ownership),
      ownership ?? new Map(),
    );
    const current = parseIndex(
      (await cli.call(root, ["ls-files", "--stage", "-z"], { env })).stdout,
    );
    if (current.some((entry) => entry.mode === "160000")) unsupportedGitlinks();
    return hash(textOutput(await cli.call(root, ["write-tree"], { write: true, env })));
  });
}
function unsupportedGitlinks(): never {
  throw new GitError(
    "unsupported_repository",
    "Full working-tree snapshots cannot include submodules or embedded repositories",
  );
}
export async function assertNoGitlinks(
  repository: Repository,
  root: string,
  tree: string,
): Promise<void> {
  const entries = parseTree(
    (await repository.cli.call(root, ["ls-tree", "-r", "-z", tree])).stdout,
  );
  if (entries.some((entry) => entry.mode === "160000")) unsupportedGitlinks();
}
export async function createCheckpoint(
  repository: Repository,
  root: string,
  threadId: string,
  label: string,
  ownership?: SnapshotOwnership,
): Promise<Checkpoint> {
  const prefix = checkpointPrefix(threadId);
  const tree = await snapshot(repository, root, ownership);
  const createdAt = (await repository.now()).toISOString();
  for (let attempt = 0; attempt < 20; attempt++) {
    const previous = await repository.numbers.get(root, threadId);
    const sequence = previous.sequence + 1;
    if (!Number.isSafeInteger(sequence))
      throw new GitError("git_failed", "Checkpoint sequence exhausted");
    const message = JSON.stringify({
      format: "ace-checkpoint-v1",
      threadId,
      label,
      createdAt,
      sequence,
    });
    const sha = hash(
      textOutput(
        await repository.cli.call(root, ["-c", "commit.gpgSign=false", "commit-tree", tree], {
          write: true,
          input: `${message}\n`,
          env: {
            GIT_AUTHOR_NAME: "ace",
            GIT_AUTHOR_EMAIL: "checkpoints@ace.local",
            GIT_COMMITTER_NAME: "ace",
            GIT_COMMITTER_EMAIL: "checkpoints@ace.local",
            GIT_AUTHOR_DATE: createdAt,
            GIT_COMMITTER_DATE: createdAt,
          },
        }),
      ),
    );
    const id = `${prefix}${sequence}`;
    const input = `start\ncreate ${id} ${sha}\nupdate ${counterRef(threadId)} ${sha} ${previous.sha ?? "0".repeat(sha.length)}\nprepare\ncommit\n`;
    const result = await repository.cli.call(root, ["update-ref", "--stdin"], {
      write: true,
      allowFailure: true,
      input,
    });
    if (result.exitCode === 0) {
      repository.numbers.remember(root, threadId, { sha, sequence });
      return { id, sha, tree, threadId, sequence, label, createdAt };
    }
    const current = await repository.numbers.refresh(root, threadId);
    if (current.sha === previous.sha) throw new GitError("git_failed", result.stderr);
  }
  throw new GitError("git_failed", "Checkpoint refs changed repeatedly; retry the operation");
}
const format = "--format=%H%x00%T%x00%B";
export async function readCheckpoint(
  repository: Repository,
  root: string,
  id: string,
): Promise<Checkpoint> {
  checkpointIdentity(id);
  const output = await repository.cli.call(
    root,
    ["log", "--no-color", "--no-show-signature", "--no-walk=unsorted", "-z", format, id, "--"],
    { allowFailure: true },
  );
  if (output.exitCode !== 0)
    throw new GitError("checkpoint_not_found", `Checkpoint not found: ${id}`);
  const commits = parseCommits(output.stdout);
  const commit = [...commits.values()][0];
  if (commits.size !== 1 || !commit) throw malformed("checkpoint commit arity");
  return checkpoint(id, commit);
}
export async function listCheckpoints(
  repository: Repository,
  root: string,
  threadId: string,
): Promise<Checkpoint[]> {
  const refs = await checkpointRefs(repository.cli, root, threadId);
  const unique = [...new Set(refs.map((ref) => ref.sha))];
  const commits = new Map<string, ParsedCommit>();
  for (let start = 0; start < unique.length; start += 500) {
    const batch = unique.slice(start, start + 500);
    const output = await repository.cli.call(root, [
      "log",
      "--no-color",
      "--no-show-signature",
      "--no-walk=unsorted",
      "-z",
      format,
      ...batch,
      "--",
    ]);
    const decoded = parseCommits(output.stdout);
    if (decoded.size !== batch.length || [...decoded.keys()].some((sha) => !batch.includes(sha)))
      throw malformed("checkpoint batch correspondence");
    for (const [sha, data] of decoded) commits.set(sha, data);
  }
  return refs.map((ref) => {
    const commit = commits.get(ref.sha);
    if (!commit) throw malformed("missing checkpoint commit");
    return checkpoint(ref.id, commit);
  });
}
export async function deleteCheckpoints(
  repository: Repository,
  root: string,
  threadId: string,
): Promise<{ deleted: number }> {
  const current = await repository.numbers.refresh(root, threadId);
  // Capture the counter before enumerating refs so a later allocation cannot
  // become the generation we delete while its checkpoint escapes enumeration.
  const refs = await checkpointRefs(repository.cli, root, threadId);
  const objectFormat = current.sha
    ? undefined
    : decode(
        z.enum(["sha1", "sha256"]),
        textOutput(await repository.cli.call(root, ["rev-parse", "--show-object-format"])),
        "object format",
      );
  const input = [
    "start",
    ...refs.map((ref) => `delete ${ref.id} ${ref.sha}`),
    current.sha
      ? `delete ${counterRef(threadId)} ${current.sha}`
      : `verify ${counterRef(threadId)} ${"0".repeat(objectFormat === "sha256" ? 64 : 40)}`,
    "prepare",
    "commit",
    "",
  ].join("\n");
  await repository.cli.call(root, ["update-ref", "--stdin"], { write: true, input });
  repository.numbers.forget(root, threadId);
  return { deleted: refs.length };
}
