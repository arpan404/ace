import { createHash } from "node:crypto";
import type { Repository } from "./repository.ts";

/**
 * What the index holds against HEAD: every staged entry's mode, object id and path, plus HEAD.
 * Read-only and proportional to the staged changes. A commit quotes back the value the person
 * reviewed and is refused if anything was staged or unstaged since.
 */
export async function indexFingerprint(
  repository: Repository,
  root: string,
  head: string | null,
  env?: Record<string, string>,
): Promise<string> {
  const base =
    head ??
    (
      await repository.cli.call(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" })
    ).stdout
      .toString("utf8")
      .trim();
  const listed = await repository.cli.call(
    root,
    ["diff-index", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", base, "--"],
    { captureBytes: 16 * 1024 * 1024, ...(env ? { env } : {}) },
  );
  return createHash("sha256")
    .update(head ?? "unborn")
    .update("\0")
    .update(listed.stdout)
    .digest("hex");
}
