import { z } from "zod";
import { GitError } from "./types.ts";

/** Command-scope configuration wins over repository, worktree, global and system files. */
const fixed: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.untrackedCache", "false"],
  ["core.attributesFile", "/dev/null"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
];
const FilterKey = z.string().regex(/^filter\.[^\0\n]+\.(?:clean|smudge|process|required)$/);

export const filterKeyQuery = [
  "config",
  "--null",
  "--name-only",
  "--get-regexp",
  "^filter\\..*\\.(clean|smudge|process|required)$",
];

/** Config inspection is read-only. It receives the same fixed execution guards. */
export function nonExecutingEnv(keys: string = ""): Record<string, string> {
  if (keys && !keys.endsWith("\0"))
    throw new GitError("malformed_output", "Invalid filter configuration");
  const parsed = z.array(FilterKey).safeParse(keys ? keys.slice(0, -1).split("\0") : []);
  if (!parsed.success) throw new GitError("malformed_output", "Invalid filter configuration");
  const drivers = new Set(parsed.data.map((key) => key.slice(0, key.lastIndexOf("."))));
  if (drivers.size > 512) throw new GitError("unsupported_repository", "Too many filter drivers");
  const pairs = [
    ...fixed,
    ...[...drivers].flatMap((name) => [
      [`${name}.clean`, ""],
      [`${name}.smudge`, ""],
      [`${name}.process`, ""],
      [`${name}.required`, "false"],
    ]),
  ];
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(pairs.length),
    GIT_ATTR_NOSYSTEM: "1",
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
