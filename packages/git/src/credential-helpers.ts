import { isUtf8 } from "node:buffer";
import { realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { z } from "zod";
import { GitError, type GitCredentialHelper } from "./types.ts";

// '=' cannot be represented in a -c key. Reject it rather than accidentally expanding trust.
const Helper = z.object({
  key: z
    .string()
    .max(4096)
    .regex(/^credential\.(?:[^\0\n=]+\.)?helper$/),
  value: z
    .string()
    .max(16_384)
    .refine((value) => !value.includes("\0")),
});
const Helpers = z.array(Helper).max(512);
interface ConfigOutput {
  stdout: Buffer;
  exitCode: number;
  truncated: boolean;
}

function values(output: ConfigOutput): string[] {
  if (output.truncated)
    throw new GitError("output_too_large", "Credential helper configuration is too large");
  if (output.exitCode !== 0 && output.exitCode !== 1)
    throw new GitError("git_failed", "Could not inspect user credential helper configuration");
  if (!isUtf8(output.stdout))
    throw new GitError("malformed_output", "Invalid credential helper configuration encoding");
  const text = output.stdout.toString("utf8");
  if (!text) return [];
  if (output.exitCode !== 0 || !text.endsWith("\0"))
    throw new GitError("malformed_output", "Invalid credential helper configuration");
  return text.slice(0, -1).split("\0");
}

/** Groups of `size` NUL-terminated fields, e.g. origin and value from `--show-origin`. */
function records(output: ConfigOutput, size: number): string[][] {
  const fields = values(output);
  if (fields.length % size)
    throw new GitError("malformed_output", "Invalid user transport configuration");
  const groups: string[][] = [];
  for (let index = 0; index < fields.length; index += size)
    groups.push(fields.slice(index, index + size));
  return groups;
}

/**
 * Whether a config file may supply transport programs. Files inside the checkout, its Git
 * directory or a protected root can be written by the agent or a PR's author, so they never can,
 * even when the person's own file includes them. Symbolic links are followed before deciding.
 */
export function trustedOrigin(untrustedRoots: readonly string[]) {
  const roots = Promise.all(untrustedRoots.map((root) => realpath(root).catch(() => undefined)));
  return async (origin: string | undefined): Promise<boolean> => {
    if (!origin?.startsWith("file:")) return false;
    const path = origin.slice("file:".length);
    if (!isAbsolute(path)) return false;
    const resolved = await realpath(path).catch(() => undefined);
    if (!resolved) return false;
    return (await roots).every(
      (root) => !root || (resolved !== root && !resolved.startsWith(root + sep)),
    );
  };
}
export type TrustedOrigin = ReturnType<typeof trustedOrigin>;

/**
 * Helpers from one of the person's own config files, following its includes and `includeIf`
 * conditions (evaluated against the checkout the query runs in), as their own Git would.
 * Entries that come from an untrusted file are dropped.
 */
export async function readCredentialHelpers(
  file: string,
  query: (args: string[]) => Promise<ConfigOutput>,
  trusted: TrustedOrigin,
): Promise<GitCredentialHelper[]> {
  // A single query preserves generic/URL-scoped helpers and empty resets in file order.
  const ordered: GitCredentialHelper[] = [];
  for (const [origin, entry] of records(
    await query([
      "config",
      "--file",
      file,
      "--includes",
      "--show-origin",
      "--null",
      "--get-regexp",
      "^credential\\.(.*\\.)?helper$",
    ]),
    2,
  )) {
    const separator = entry?.indexOf("\n") ?? -1;
    if (entry === undefined || separator < 0)
      throw new GitError("malformed_output", "Invalid credential helper configuration");
    if (await trusted(origin))
      ordered.push({ key: entry.slice(0, separator), value: entry.slice(separator + 1) });
  }
  return validateHelpers(ordered);
}

/** `core.sshCommand` values from one of the person's own files, under the same trust rule. */
export async function readSshCommands(
  file: string,
  query: (args: string[]) => Promise<ConfigOutput>,
  trusted: TrustedOrigin,
): Promise<string[]> {
  const commands: string[] = [];
  for (const [origin, value] of records(
    await query([
      "config",
      "--file",
      file,
      "--includes",
      "--show-origin",
      "--null",
      "--get-all",
      "core.sshCommand",
    ]),
    2,
  ))
    if (value !== undefined && (await trusted(origin))) commands.push(value);
  return commands;
}

/** The repository's own `core.sshCommand` values (local and worktree scope), in Git's order. */
export async function repositorySshCommands(
  query: (args: string[]) => Promise<ConfigOutput>,
): Promise<string[]> {
  return records(
    await query(["config", "--show-scope", "--null", "--get-all", "core.sshCommand"]),
    2,
  ).flatMap(([scope, value]) =>
    (scope === "local" || scope === "worktree") && value !== undefined ? [value] : [],
  );
}

/** Resolve Git's compiled system file without assuming its installation prefix. Names only,
 * pinned to system scope, with includes disabled. This also works on Git before `git var`
 * learned GIT_CONFIG_SYSTEM. It is found by any key a transfer borrows from it (a credential
 * helper or `core.sshCommand`); a system file setting neither has nothing to restore. */
export async function systemCredentialConfigFile(
  query: (args: string[]) => Promise<ConfigOutput>,
): Promise<string | undefined> {
  const entries = values(
    await query([
      "config",
      "--system",
      "--no-includes",
      "--null",
      "--show-origin",
      "--name-only",
      "--get-regexp",
      "^(credential\\.(.*\\.)?helper|core\\.sshcommand)$",
    ]),
  );
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index += 2) {
    const origin = entries[index];
    const key = entries[index + 1];
    if (
      !origin?.startsWith("file:") ||
      origin.length === 5 ||
      !key ||
      !(Helper.shape.key.safeParse(key).success || key === "core.sshcommand")
    )
      throw new GitError("malformed_output", "Invalid system credential config origin");
    const path = origin.slice(5);
    if (!isAbsolute(path))
      throw new GitError("malformed_output", "Invalid system credential config path");
    paths.add(path);
  }
  if (paths.size > 1)
    throw new GitError("malformed_output", "Ambiguous system credential config origin");
  return paths.values().next().value;
}

function validateHelpers(helpers: readonly GitCredentialHelper[]): GitCredentialHelper[] {
  const parsed = Helpers.safeParse(helpers);
  if (!parsed.success)
    throw new GitError("malformed_output", "Invalid user credential helper configuration");
  return parsed.data;
}

/** Command configuration is read last: discard every inherited helper before restoring trust. */
export function credentialHelperArgs(helpers: readonly GitCredentialHelper[]): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    ...validateHelpers(helpers).flatMap(({ key, value }) => ["-c", `${key}=${value}`]),
  ];
}
