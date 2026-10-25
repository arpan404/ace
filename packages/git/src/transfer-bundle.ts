import { rm, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { longWriteTimeoutMs } from "./deadlines.ts";
import type { Repository } from "./repository.ts";
import { assertBundleFile, assertRefArguments } from "./transfer-bundle-file.ts";
import { GitError } from "./types.ts";

const missingPrerequisites =
  /lacks these prerequisite commits|prerequisite commits? (?:are )?missing/i;

/**
 * Write `refs` and the history they need to `file`, minus everything reachable from `exclude`
 * (origin-tracking refs, for a bundle of only what origin lacks). Git refuses a bundle with no
 * commits in it: that is `{ empty: true }`, and no file is left.
 */
export async function createBundle(
  repository: Repository,
  root: string,
  options: { file: string; refs: readonly string[]; exclude?: readonly string[] | undefined },
): Promise<{ bytes: number } | { empty: true }> {
  if (!isAbsolute(options.file) || /[\0\n]/.test(options.file))
    throw new GitError("invalid_argument", "A bundle must be written to an absolute file path");
  const exclude = options.exclude ?? [];
  if (!options.refs.length) throw new GitError("invalid_ref", "A bundle needs at least one ref");
  assertRefArguments(options.refs, "bundle ref");
  assertRefArguments(exclude, "excluded ref");
  const result = await repository.cli.call(
    root,
    [
      "bundle",
      "create",
      "--quiet",
      options.file,
      ...options.refs,
      ...(exclude.length ? ["--not", ...exclude] : []),
    ],
    { allowFailure: true, timeoutMs: longWriteTimeoutMs },
  );
  if (result.exitCode !== 0) {
    await rm(options.file, { force: true });
    if (/Refusing to create empty bundle/i.test(result.stderr)) return { empty: true };
    throw new GitError("git_failed", "Could not create the bundle", { stderr: result.stderr });
  }
  return { bytes: (await stat(options.file)).size };
}

/** Whether this repository has every commit the bundle builds on. */
export async function verifyBundle(
  repository: Repository,
  root: string,
  bundle: string,
  directoryFd?: number,
): Promise<boolean> {
  await assertBundleFile(bundle);
  const result = await repository.cli.call(root, ["bundle", "verify", bundle], {
    allowFailure: true,
    timeoutMs: longWriteTimeoutMs,
    directoryFd,
  });
  if (result.exitCode === 0) return true;
  if (missingPrerequisites.test(result.stderr)) return false;
  throw new GitError("invalid_argument", "The bundle is not readable", { stderr: result.stderr });
}

/**
 * Fetch `refspecs` (`<bundle ref>:<local ref>`) from a bundle into the repository. Tags come only
 * when a refspec names them. A bundle building on commits the repository lacks fails with
 * `objects_not_available`.
 */
export async function fetchBundle(
  repository: Repository,
  root: string,
  bundle: string,
  refspecs: readonly string[],
  options: { updateHead?: boolean; directoryFd?: number | undefined } = {},
): Promise<void> {
  await assertBundleFile(bundle);
  if (!refspecs.length) throw new GitError("invalid_ref", "A bundle fetch needs a refspec");
  assertRefArguments(refspecs, "refspec");
  const result = await repository.cli.fetchBundle(
    root,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--no-auto-gc",
      ...(options.updateHead ? ["--update-head-ok"] : []),
      "--",
      bundle,
      ...refspecs,
    ],
    {
      write: true,
      allowFailure: true,
      timeoutMs: longWriteTimeoutMs,
      directoryFd: options.directoryFd,
    },
  );
  if (result.exitCode === 0) return;
  if (missingPrerequisites.test(result.stderr))
    throw new GitError(
      "objects_not_available",
      "The bundle builds on commits this repository lacks",
    );
  throw new GitError("git_failed", "Could not fetch from the bundle", { stderr: result.stderr });
}
