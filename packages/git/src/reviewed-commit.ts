import { isAcePrivate } from "./ace-private.ts";
import { longWriteTimeoutMs } from "./deadlines.ts";
import { failureMessage } from "./failure-text.ts";
import { fileFingerprint } from "./file-fingerprint.ts";
import { indexFingerprint } from "./index-fingerprint.ts";
import type { Repository } from "./repository.ts";
import { withIndex } from "./temporary-index.ts";
import { GitError, type ReviewedFile } from "./types.ts";

const text = (output: { stdout: Buffer }) => output.stdout.toString("utf8").trim();
const nulList = (output: { stdout: Buffer }) =>
  output.stdout.toString("utf8").split("\0").filter(Boolean);

/** The commit made, and whether the branch had moved past the HEAD the person reviewed. */
export interface CommitOutcome {
  commit: string;
  branchMoved: boolean;
}

export interface ReviewedCommitOptions {
  root: string;
  message: string;
  /** HEAD as the person reviewed it, already checked against the checkout under the lock. */
  head: string | null;
  amend: boolean;
  /** Amend even though a remote already has the commit (the person confirmed). */
  amendPublished: boolean;
  /** Staged-only: the index fingerprint the person reviewed. */
  expectedIndex?: string | undefined;
  /** Commit-all: exactly the files the person reviewed, with their fingerprints. */
  reviewed?: readonly ReviewedFile[] | undefined;
  beforeCommit?: (() => void) | undefined;
  /** ace's own reads: they keep the checkout's protections inside a person's commit. */
  read: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Commit exactly what the person reviewed. The tree is built in a temporary index the checkout
 * can't touch: a snapshot of the staged entries whose fingerprint must equal the reviewed one,
 * or HEAD plus the reviewed files, each refused if its fingerprint moved. The person's own
 * `git commit` then commits that index (their hooks and signing run). Git's own compare-and-swap
 * on HEAD refuses a commit whose HEAD moved while Git ran. If HEAD moved earlier (after the
 * review, before Git read it), the commit lands on top and `branchMoved` says so: no ref is ever
 * moved back, so no one's commit is destroyed.
 */
export async function reviewedCommit(
  repository: Repository,
  options: ReviewedCommitOptions,
): Promise<CommitOutcome> {
  const { root, head, read } = options;
  const call = repository.cli.call.bind(repository.cli);
  if (options.amend && !options.amendPublished && head) {
    const published = await read(() =>
      call(root, [
        "for-each-ref",
        "--count=1",
        "--contains",
        head,
        "--format=%(refname)",
        "refs/remotes",
      ]),
    );
    if (text(published)) throw new GitError("amend_published", failureMessage("amend_published"));
  }
  const parentsOf = async (commit: string) =>
    text(await read(() => call(root, ["show", "-s", "--format=%P", commit])))
      .split(" ")
      .filter(Boolean);
  const expectedParents = options.amend && head ? await parentsOf(head) : head ? [head] : [];
  const emptyTree = async () =>
    text(await read(() => call(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" })));

  await withIndex(repository.tempDirectory, async (env) => {
    if (options.reviewed) {
      const files = options.reviewed;
      const unchanged = async () => {
        for (const file of files)
          if ((await fileFingerprint(root, file.path)) !== file.fingerprint)
            throw new GitError("changed_since_review", failureMessage("changed_since_review"));
      };
      await read(() =>
        call(root, ["read-tree", ...(head ? [head] : ["--empty"])], { write: true, env }),
      );
      await unchanged();
      await read(() =>
        call(root, ["update-index", "--add", "--remove", "-z", "--stdin"], {
          write: true,
          env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
          input: files.map((file) => `${file.path}\0`).join(""),
        }),
      );
      // The bytes hashed are the bytes reviewed: nothing changed while Git read them.
      await unchanged();
    } else {
      const entries = await read(() => call(root, ["ls-files", "--stage", "-z"]));
      await read(() => call(root, ["read-tree", "--empty"], { write: true, env }));
      await read(() =>
        call(root, ["update-index", "-z", "--index-info"], {
          write: true,
          env,
          input: nulList(entries)
            .map((line) => `${line}\0`)
            .join(""),
        }),
      );
      if (
        (await read(() => indexFingerprint(repository, root, head, env))) !== options.expectedIndex
      )
        throw new GitError("index_moved", failureMessage("index_moved"));
    }
    const base = head ?? (await emptyTree());
    const staged = nulList(
      await read(() =>
        call(root, ["diff-index", "--cached", "--name-only", "-z", base, "--"], { env }),
      ),
    );
    if (staged.some(isAcePrivate))
      throw new GitError("private_path_staged", failureMessage("private_path_staged"));
    try {
      await call(root, ["commit", "--file=-", ...(options.amend ? ["--amend"] : [])], {
        write: true,
        beforeSpawn: options.beforeCommit,
        timeoutMs: longWriteTimeoutMs,
        input: options.message,
        captureBytes: 65536,
        env: { ...env, GIT_TRACE2_EVENT: "1" },
      });
    } catch (error) {
      // Git's own compare-and-swap on HEAD refused: something committed while this one ran.
      const stderr = error instanceof GitError ? error.details.stderr : undefined;
      if (typeof stderr === "string" && /cannot lock ref 'HEAD'|but expected/i.test(stderr))
        throw new GitError("head_moved", "HEAD moved while committing; nothing was committed", {
          stderr,
        });
      throw error;
    }
  });

  const created = text(await read(() => call(root, ["rev-parse", "--verify", "HEAD"])));
  // Something committed between the review and this commit (a hook, a terminal): Git placed
  // ours on top of it. No ref is ever moved back, so no one's commit is lost; the person is told
  // the branch moved and checks the history.
  const branchMoved = (await parentsOf(created)).join(" ") !== expectedParents.join(" ");
  const base = branchMoved ? `${created}^` : (head ?? "--root");
  // The real index catches up with what was committed, path by path.
  const changed = nulList(
    await read(() =>
      call(root, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", base, created]),
    ),
  ).filter((path) => path !== created);
  if (changed.length > 0)
    await read(() =>
      call(root, ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        write: true,
        env: { GIT_LITERAL_PATHSPECS: "1" },
        input: changed.map((path) => `${path}\0`).join(""),
      }),
    );
  return { commit: created, branchMoved };
}
