import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git for Windows resolves `/dev/null/<hook>` against the drive root (C:\dev\null\...),
// a path another user could populate. On Windows, hooks point at a private empty
// directory this process owns for its lifetime instead.
let windowsHooks: string | undefined;

function privateEmptyDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), "ace-git-hooks-"));
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

export function disabledHooksPath(): string {
  if (process.platform !== "win32") return "/dev/null";
  windowsHooks ??= privateEmptyDirectory();
  return windowsHooks;
}

export function withoutHooks(): string[] {
  return ["-c", `core.hooksPath=${disabledHooksPath()}`];
}
