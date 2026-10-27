import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git for Windows resolves `/dev/null/<hook>` against the drive root (C:\dev\null\...),
// a path another user could populate. On Windows every hook switch is rewritten, where
// Git is spawned, to a private empty folder this process owns for its lifetime.
const posixHooks = "/dev/null";
let windowsHooks: string | undefined;

function privateEmptyDirectory(): string {
  if (windowsHooks !== undefined) return windowsHooks;
  const created = mkdtempSync(join(tmpdir(), "ace-git-hooks-"));
  windowsHooks = created;
  process.once("exit", () => {
    try {
      // rmdir, never a recursive delete: an unexpected entry stays put.
      rmdirSync(created);
    } catch {
      // Best effort; no checkout data lives here.
    }
  });
  return created;
}

/** Windows only: `-c core.hooksPath=/dev/null` arguments name the private empty folder. */
export function windowsHooklessArgs(args: readonly string[]): string[] {
  return args.map((arg, index) =>
    args[index - 1] === "-c" && arg === `core.hooksPath=${posixHooks}`
      ? `core.hooksPath=${privateEmptyDirectory()}`
      : arg,
  );
}

/** Windows only: command-scope `core.hooksPath=/dev/null` entries name the private folder. */
export function windowsHooklessEnv(env: Record<string, string | undefined>): void {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (let index = 0; Number.isSafeInteger(count) && index < count; index += 1) {
    if (
      env[`GIT_CONFIG_KEY_${index}`] === "core.hooksPath" &&
      env[`GIT_CONFIG_VALUE_${index}`] === posixHooks
    )
      env[`GIT_CONFIG_VALUE_${index}`] = privateEmptyDirectory();
  }
}

/** Windows only: command-scope `core.longpaths=true` appended after the caller's entries. */
export function windowsLongPathsEnv(env: Record<string, string | undefined>): void {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) return;
  env[`GIT_CONFIG_KEY_${count}`] = "core.longpaths";
  env[`GIT_CONFIG_VALUE_${count}`] = "true";
  env.GIT_CONFIG_COUNT = String(count + 1);
}
