import { open, realpath } from "node:fs/promises";
import { delimiter } from "node:path";
import { findExecutable } from "@ace/provider-kit/discovery";
import { isDesktopShim } from "@ace/service/home";
import type { Verdict } from "./install-versions.ts";

/** One `ace` on PATH and the installation it runs. */
export type AceOnPath = { path: string; install: string };

/** The first `maxBytes` of a file, or undefined when it can't be read. */
export async function readHead(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Which installation a small `ace` script runs: the app bundle a desktop shim execs, or the
 * data home a release launcher sets. Anything else is its own installation.
 */
export function installOf(resolved: string, script: string | undefined): string {
  if (script && isDesktopShim(script)) {
    const entry = /^exec .*'([^']+\/ace\.mjs)'/m.exec(script)?.[1];
    const app = entry ? /^(.+\.app)\//.exec(entry)?.[1] : undefined;
    return app ?? entry ?? resolved;
  }
  const home = script ? /^ACE_HOME='([^']+)'$/m.exec(script)?.[1] : undefined;
  return home ?? resolved;
}

/** Every `ace` executable on PATH, in PATH order, one per real file. */
export async function aceOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<AceOnPath[]> {
  const separator = platform === "win32" ? ";" : delimiter;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const directories = (env[pathKey] ?? "").split(separator).filter((part) => part !== "");
  const found: AceOnPath[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    // One directory at a time and no HOME, so only PATH entries are searched.
    const path = await findExecutable(
      "ace",
      { PATH: directory, ...(env.PATHEXT ? { PATHEXT: env.PATHEXT } : {}) },
      platform,
    );
    if (!path) continue;
    const resolved = await realpath(path).catch(() => path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    found.push({ path, install: installOf(resolved, await readHead(resolved, 4096)) });
  }
  return found;
}

/** Warns when PATH holds `ace` commands from different installations, naming the one that runs. */
export function pathVerdict(found: readonly AceOnPath[]): Verdict {
  const [first] = found;
  if (!first)
    return {
      status: "ok",
      message:
        "No ace command on PATH. The ace app installs it in ~/.ace/bin and puts it on PATH when it opens",
      fix: "Turn on ace command in terminals in ace's Settings > General, or add ~/.ace/bin to PATH.",
    };
  const installs = new Set(found.map((entry) => entry.install));
  if (installs.size === 1)
    return {
      status: "ok",
      message: `ace on PATH: ${first.path}${first.install === first.path ? "" : ` (runs ${first.install})`}`,
      fix: "Nothing to do.",
    };
  const others = found.slice(1).filter((entry) => entry.install !== first.install);
  return {
    status: "warn",
    message:
      `${installs.size} different ace installations are on PATH. ${first.path}${first.install === first.path ? "" : ` (runs ${first.install})`} wins; also found ${others.map((entry) => entry.path).join(", ")}`.slice(
        0,
        2048,
      ),
    fix: `Remove the ace installs you no longer use (${others.map((entry) => entry.path).join(", ")}), or put the one you want first on PATH.`.slice(
      0,
      2048,
    ),
  };
}
