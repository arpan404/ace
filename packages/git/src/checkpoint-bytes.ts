import { z } from "zod";
import { textOutput } from "./cli.ts";
import { checkpointPrefix } from "./checkpoint-metadata.ts";
import { checkpointRefs } from "./checkpoint-numbers.ts";
import { longWriteTimeoutMs } from "./deadlines.ts";
import { decode, hash, malformed } from "./decode.ts";
import { parseTree } from "./parse-index.ts";
import type { Repository } from "./repository.ts";
import { withIndex } from "./temporary-index.ts";
import { GitError, type Checkpoint } from "./types.ts";

// Windows checkouts usually convert line endings (core.autocrlf=true), so the tree Git stores
// for a file is not its bytes. A checkpoint keeps that converted tree for diffs and records the
// files' own bytes beside it, which a restore writes back with every conversion switched off.

/** Attributes that leave every path's bytes alone: no eol conversion, filter, ident or encoding. */
const neutralAttributes = "* -text -filter -ident -working-tree-encoding\n";

function bytesPrefix(threadId: string): string {
  checkpointPrefix(threadId);
  return `refs/ace/checkpoint-bytes/${threadId}/`;
}

/** `tree` with every regular file re-hashed from the checkout exactly as it is on disk. */
export async function bytesTree(repository: Repository, root: string, tree: string) {
  const { cli } = repository;
  const files = parseTree((await cli.call(root, ["ls-tree", "-r", "-z", tree])).stdout).filter(
    (entry) => entry.mode === "100644" || entry.mode === "100755",
  );
  if (!files.length) return tree;
  // --no-filters skips autocrlf, eol, safecrlf and every attribute, including the person's
  // own .git/info/attributes, which no command-line setting can override.
  const output = textOutput(
    await cli.call(root, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      write: true,
      timeoutMs: longWriteTimeoutMs,
      input: files.map((entry) => `${quoted(entry.path)}\n`).join(""),
    }),
  );
  const hashes = output.split("\n").map((line) => hash(line));
  if (hashes.length !== files.length) throw malformed("hash-object path correspondence");
  const changed = files.flatMap((entry, index) => {
    const sha = hashes[index];
    return sha && sha !== entry.sha ? [`${entry.mode} ${sha} 0\t${entry.path}\0`] : [];
  });
  if (!changed.length) return tree;
  return withIndex(repository.tempDirectory, async (env) => {
    await cli.call(root, ["read-tree", tree], { write: true, env });
    await cli.call(root, ["update-index", "-z", "--index-info"], {
      write: true,
      env,
      input: changed.join(""),
    });
    return hash(textOutput(await cli.call(root, ["write-tree"], { write: true, env })));
  });
}

/** Git's C-style quoting, which `--stdin-paths` undoes, so any path survives one line. */
function quoted(path: string): string {
  let text = '"';
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (character === '"' || character === "\\") text += `\\${character}`;
    else if (code < 0x20 || code === 0x7f) text += `\\${code.toString(8).padStart(3, "0")}`;
    else text += character;
  }
  return `${text}"`;
}

/** Keeps a checkpoint's bytes tree reachable under a ref named for the checkpoint commit. */
export async function recordBytes(
  repository: Repository,
  root: string,
  threadId: string,
  checkpoint: string,
  bytes: string,
  createdAt: string,
): Promise<void> {
  const commit = hash(
    textOutput(
      await repository.cli.call(root, ["-c", "commit.gpgSign=false", "commit-tree", bytes], {
        write: true,
        input: "ace checkpoint bytes\n",
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
  await repository.cli.call(root, ["update-ref", `${bytesPrefix(threadId)}${checkpoint}`, commit], {
    write: true,
  });
}

/** The files' own bytes for `checkpoint`, or its tree when none were recorded beside it. */
export async function checkpointBytes(
  repository: Repository,
  root: string,
  checkpoint: Checkpoint,
): Promise<string> {
  const found = await repository.cli.call(
    root,
    [
      "rev-parse",
      "--verify",
      "--quiet",
      `${bytesPrefix(checkpoint.threadId)}${checkpoint.sha}^{tree}`,
    ],
    { allowFailure: true },
  );
  if (found.exitCode === 0) return hash(textOutput(found));
  if (found.exitCode !== 1) throw new GitError("git_failed", found.stderr);
  return checkpoint.tree;
}

/** Drops the bytes refs of every checkpoint `threadId` no longer has. */
export async function forgetBytes(
  repository: Repository,
  root: string,
  threadId: string,
): Promise<void> {
  const prefix = bytesPrefix(threadId);
  const output = textOutput(
    await repository.cli.call(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      prefix,
    ]),
  );
  if (!output) return;
  const live = new Set(
    (await checkpointRefs(repository.cli, root, threadId)).map((ref) => ref.sha),
  );
  const stale = output.split("\n").flatMap((record) => {
    const [ref, sha] = decode(
      z.tuple([z.string().startsWith(prefix), z.string()]),
      record.split("\0"),
      "checkpoint bytes ref",
    );
    return live.has(ref.slice(prefix.length)) ? [] : [`delete ${ref} ${hash(sha)}`];
  });
  if (!stale.length) return;
  await repository.cli.call(root, ["update-ref", "--stdin"], {
    write: true,
    input: ["start", ...stale, "prepare", "commit", ""].join("\n"),
  });
}

/**
 * Settings for a checkout that writes blobs as they are, or undefined when this Git predates
 * `--attr-source` (2.41). The neutral attributes tree lives in `root`'s own object database.
 */
export async function exactCheckoutArgs(
  repository: Repository,
  root: string,
): Promise<string[] | undefined> {
  const { cli } = repository;
  const blob = hash(
    textOutput(
      await cli.call(root, ["hash-object", "-w", "--no-filters", "--stdin"], {
        write: true,
        input: neutralAttributes,
      }),
    ),
  );
  const tree = hash(
    textOutput(
      await cli.call(root, ["mktree"], {
        write: true,
        input: `100644 blob ${blob}\t.gitattributes\n`,
      }),
    ),
  );
  const probe = await cli.call(root, [`--attr-source=${tree}`, "check-attr", "text", "--", "x"], {
    allowFailure: true,
  });
  if (probe.exitCode !== 0) {
    if (/attr-source/.test(probe.stderr)) return undefined;
    throw new GitError("git_failed", probe.stderr);
  }
  return [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "-c",
    "core.safecrlf=false",
    `--attr-source=${tree}`,
  ];
}
