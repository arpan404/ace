import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { GitError } from "./types.ts";

const signatures = new Set(["# v2 git bundle\n", "# v3 git bundle\n"]);

/**
 * A bundle path is the one place ace opens Git's `file` transport, so it must name exactly a
 * bundle: an absolute path to a regular file (not a link, folder or repository) that starts
 * with a bundle signature. Anything else would let `file` reach another repository.
 */
export async function assertBundleFile(bundle: string): Promise<void> {
  if (!isAbsolute(bundle) || bundle.includes("\0") || bundle.includes("\n"))
    throw new GitError("invalid_argument", "A bundle must be an absolute file path");
  const info = await lstat(bundle).catch(() => undefined);
  if (!info?.isFile()) throw new GitError("invalid_argument", "The bundle file does not exist");
  const handle = await open(bundle, "r");
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const text = head.subarray(0, bytesRead).toString("latin1");
    if (!signatures.has(text))
      throw new GitError("invalid_argument", "The file is not a Git bundle");
  } finally {
    await handle.close();
  }
}

/** Refs and refspecs reach Git as arguments: they may never read as options. */
export function assertRefArguments(values: readonly string[], what: string): void {
  for (const value of values)
    if (!value || value.startsWith("-") || /[\0\n]/.test(value))
      throw new GitError("invalid_ref", `Invalid ${what}: ${value}`);
}
