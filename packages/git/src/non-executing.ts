import { z } from "zod";
import { GitError } from "./types.ts";

// Event switches also prevent a concurrently added named hook from bypassing inspection.
const hookEvents = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
];
/** Command-scope configuration wins over repository, worktree, global and system files. */
const fixed: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.untrackedCache", "false"],
  ["core.attributesFile", "/dev/null"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ...hookEvents.map((event): readonly [string, string] => [`hook.${event}.enabled`, "false"]),
];
const FilterKey = z.string().regex(/^filter\.[^\0\n]+\.(?:clean|smudge|process|required)$/);
const HookKey = z.string().regex(/^hook\.[^\0\n]+\.(?:event|command)$/);

export const executionKeyQuery = [
  "config",
  "--null",
  "--name-only",
  "--get-regexp",
  "^(filter\\..*\\.(clean|smudge|process|required)|hook\\..*\\.(event|command))$",
];

/** Config inspection is read-only. It receives the same fixed execution guards. */
export function nonExecutingEnv(keys: string = ""): Record<string, string> {
  if (keys && !keys.endsWith("\0"))
    throw new GitError("malformed_output", "Invalid Git execution configuration");
  const parsed = z
    .array(z.union([FilterKey, HookKey]))
    .safeParse(keys ? keys.slice(0, -1).split("\0") : []);
  if (!parsed.success)
    throw new GitError("malformed_output", "Invalid Git execution configuration");
  const drivers = new Set(
    parsed.data
      .filter((key) => key.startsWith("filter."))
      .map((key) => key.slice(0, key.lastIndexOf("."))),
  );
  const hooks = new Set(
    parsed.data
      .filter((key) => key.startsWith("hook."))
      .map((key) => key.slice(0, key.lastIndexOf("."))),
  );
  if (drivers.size > 512 || hooks.size > 512)
    throw new GitError("unsupported_repository", "Too many execution extensions");
  const pairs = [
    ...fixed,
    ...[...drivers].flatMap((name) => [
      [`${name}.clean`, ""],
      [`${name}.smudge`, ""],
      [`${name}.process`, ""],
      [`${name}.required`, "false"],
    ]),
    // Named hooks are collected separately from core.hooksPath on newer Git. Empty events
    // reset the accumulated multi-valued list; enabled=false also covers event switches.
    ...[...hooks].flatMap((name) => [
      [`${name}.event`, ""],
      [`${name}.enabled`, "false"],
    ]),
  ];
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(pairs.length),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const [index, pair] of pairs.entries()) {
    const [key, value] = pair;
    if (key === undefined || value === undefined)
      throw new GitError("invalid_argument", "Invalid Git policy");
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return env;
}

/** Only an explicitly admitted transfer may use transports. Repository protocol overrides lose. */
export function nonExecutingTransportEnv(
  keys: string,
  protocols: readonly string[] = ["http", "https", "ssh"],
): Record<string, string> {
  const allowed = z
    .array(z.enum(["http", "https", "ssh", "file"]))
    .max(4)
    .parse(protocols);
  return {
    ...nonExecutingEnv(keys),
    GIT_ALLOW_PROTOCOL: allowed.join(":"),
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    GIT_ASKPASS: "",
    GIT_TERMINAL_PROMPT: "0",
  };
}
