import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The ripgrep the Cursor SDK should use on Windows ARM64, where it ships no helper package.
 * Without `CURSOR_RIPGREP_PATH` the SDK falls back to `rg.exe` in its working directory (the
 * user's workspace) before PATH. This picks the first absolute PATH folder holding `rg.exe`
 * instead; the desktop app puts its own `resources\bin` first. Returns `undefined` when no change
 * is needed or nothing was found.
 */
export function windowsArm64RipgrepPath(
  env: NodeJS.ProcessEnv,
  platform: string,
  arch: string,
  exists: (path: string) => boolean = isFile,
): string | undefined {
  if (platform !== "win32" || arch !== "arm64") return undefined;
  const pinned = env.CURSOR_RIPGREP_PATH;
  if (pinned && isAbsolute(pinned)) return undefined;
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  for (const folder of (key ? env[key] : undefined)?.split(delimiter) ?? []) {
    if (!folder || !isAbsolute(folder)) continue;
    const candidate = join(folder, "rg.exe");
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
