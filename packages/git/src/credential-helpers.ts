import { isUtf8 } from "node:buffer";
import { isAbsolute } from "node:path";
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

/** Only explicit scope files are consulted. Includes could redirect us into agent-owned files. */
export async function readCredentialHelpers(
  file: string,
  query: (args: string[]) => Promise<ConfigOutput>,
): Promise<GitCredentialHelper[]> {
  // A single query preserves generic/URL-scoped helpers and empty resets in file order.
  const ordered = values(
    await query([
      "config",
      "--file",
      file,
      "--no-includes",
      "--null",
      "--get-regexp",
      "^credential\\.(.*\\.)?helper$",
    ]),
  ).map((entry) => {
    const separator = entry.indexOf("\n");
    if (separator < 0)
      throw new GitError("malformed_output", "Invalid credential helper configuration");
    return { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
  return validateHelpers(ordered);
}

/** Resolve Git's compiled system file without assuming its installation prefix. Names only,
 * pinned to system scope, with includes disabled. This also works on Git before `git var`
 * learned GIT_CONFIG_SYSTEM. An empty system helper configuration needs no restoration. */
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
      "^credential\\.(.*\\.)?helper$",
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
      !Helper.shape.key.safeParse(key).success
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
