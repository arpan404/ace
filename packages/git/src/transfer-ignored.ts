import { nul } from "./decode.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

/**
 * The paths Git ignores in a checkout, as `git ls-files --others --ignored --exclude-standard
 * --directory` lists them: files, and a whole ignored folder once with a trailing `/` (so
 * dependency folders are never walked here). Nested repositories also end in `/`. The list is
 * never logged; the names may be secret. `under` (work-tree relative) lists only that folder's,
 * still relative to the work tree's top.
 */
export async function ignoredPaths(
  repository: Repository,
  root: string,
  under?: string,
): Promise<string[]> {
  const result = await repository.cli.call(
    root,
    [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      ...(under ? ["--", `:(literal)${under}`] : []),
    ],
    { captureBytes: 16 * 1024 * 1024 },
  );
  if (result.truncated) throw new GitError("git_failed", "Too many ignored paths to list");
  return nul(result.stdout);
}
