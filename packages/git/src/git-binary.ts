import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** The executable a bare `git` names on `path`, as `execvp` would find it. */
async function firstOnPath(path: string | undefined): Promise<string | undefined> {
  for (const directory of (path ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, "git");
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * On macOS `/usr/bin/git` is an `xcrun` shim that looks up the active developer directory (and
 * writes its lookup cache) on every run before starting the real Git. The real binary it would
 * start, or undefined anywhere else and whenever that can't be told.
 */
export async function developerToolsGit(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (platform !== "darwin" || (await firstOnPath(env.PATH)) !== "/usr/bin/git") return undefined;
  const found = await new Promise<string | undefined>((resolve) => {
    execFile(
      "/usr/bin/xcrun",
      ["--find", "git"],
      { env, timeout: 10_000, maxBuffer: 65_536, encoding: "utf8" },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
  });
  if (!found || !isAbsolute(found) || found.includes("\n") || found === "/usr/bin/git")
    return undefined;
  return (await executable(found)) ? found : undefined;
}
