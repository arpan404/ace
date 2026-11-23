import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  readCredentialHelpers,
  readSshCommands,
  repositorySshCommands,
  trustedOrigin,
} from "./credential-helpers.ts";
import { GitError, type GitCredentialHelper } from "./types.ts";

interface ConfigOutput {
  stdout: Buffer;
  exitCode: number;
  truncated: boolean;
}
type Query = (args: string[]) => Promise<ConfigOutput>;

/** The checkout's working tree and Git common directory, as absolute paths. */
async function checkoutRoots(query: Query, isWindows: boolean): Promise<string[]> {
  const roots: string[] = [];
  for (const flag of ["--show-toplevel", "--git-common-dir"]) {
    const output = await query(["rev-parse", "--path-format=absolute", flag]);
    // One path per invocation. Non-UTF-8 keeps proceeding as before (no new throw);
    // valid UTF-8 strips one terminator, CRLF only on Windows.
    const path = singlePath(output, isWindows);
    if (path && isAbsolute(path) && !output.truncated) roots.push(path);
    else if (flag === "--git-common-dir")
      throw new GitError("not_a_repo", "Could not locate the repository for a transfer");
  }
  return roots;
}

/** One `rev-parse` path value: strip one LF terminator (CRLF only on Windows). */
function singlePath(output: ConfigOutput, isWindows: boolean): string | undefined {
  if (output.exitCode !== 0) return undefined;
  const text = output.stdout.toString("utf8");
  if (isWindows && text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

async function present(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new GitError("filesystem_error", "Could not read user credential config file");
  }
}

/**
 * What an admitted transfer may borrow from the person's configuration: their credential
 * helpers and SSH command from their own files (system, XDG, global; includes followed), never
 * from a file inside the checkout, its Git directory or a protected root. The repository's own
 * `core.sshCommand` counts only when `repositorySsh` (a checkout no agent or PR author controls).
 */
export async function userTransportConfig(options: {
  files: readonly (string | undefined)[];
  query: Query;
  protectedRoots: readonly string[];
  helpers: boolean;
  repositorySsh: boolean;
  platform: NodeJS.Platform;
  signal?: AbortSignal | undefined;
}): Promise<{ helpers: GitCredentialHelper[]; sshCommand: string | undefined }> {
  const trusted = trustedOrigin([
    ...(await checkoutRoots(options.query, options.platform === "win32")),
    ...options.protectedRoots,
  ]);
  const helpers: GitCredentialHelper[] = [];
  const commands: string[] = [];
  for (const file of options.files) {
    if (file === undefined) continue;
    options.signal?.throwIfAborted();
    if (!(await present(file))) continue;
    if (options.helpers)
      helpers.push(...(await readCredentialHelpers(file, options.query, trusted)));
    commands.push(...(await readSshCommands(file, options.query, trusted)));
  }
  if (options.repositorySsh) commands.push(...(await repositorySshCommands(options.query)));
  // Git's last value wins; an empty value means plain ssh again.
  return { helpers, sshCommand: commands.at(-1) || undefined };
}
