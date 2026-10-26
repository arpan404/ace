import { delimiter, isAbsolute, resolve } from "node:path";
import { win32 } from "node:path";
import { probeOutput } from "../process.ts";
import { findExecutable, scriptExecutablePaths } from "./executable.ts";
import { windowsEnv, windowsFallbackPaths } from "./executable.ts";
import { parseVersion } from "./parsers.ts";

/** OpenCode v1 is a different CLI. Only v2 may own an ace OpenCode binding. */
export async function findOpenCodeExecutable(
  command: string,
  options: {
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    probe?: typeof probeOutput;
  },
): Promise<{ path: string; version: string } | undefined> {
  const explicit = isAbsolute(command) || command.includes("/") || command.includes("\\");
  const candidates = explicit
    ? [command]
    : [
        ...(options.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => resolve(dir, command)),
        ...(options.env.HOME && isAbsolute(options.env.HOME)
          ? [resolve(options.env.HOME, scriptExecutablePaths.opencode)]
          : []),
      ];
  // Windows: case-insensitive `Path`, `;` separators, and installer folders instead of HOME.
  if (process.platform === "win32" && !explicit)
    candidates.splice(0, candidates.length, ...windowsCandidates(command, options.env));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    const path = await findExecutable(candidate, options.env);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    try {
      const output = await (options.probe ?? probeOutput)(path, ["--version"], {
        env: options.env,
        timeoutMs: options.timeoutMs ?? 10_000,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const version = output.code === 0 ? parseVersion("opencode", output.stdout) : undefined;
      if (version?.startsWith("2.")) return { path, version };
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  return undefined;
}

function windowsCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const path = windowsEnv(env, "PATH") ?? "";
  return [
    ...path
      .split(";")
      .filter((dir) => win32.isAbsolute(dir))
      .map((dir) => win32.join(dir, command)),
    ...windowsFallbackPaths("opencode", env),
  ];
}
