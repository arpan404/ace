import { access, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { findExecutable, versionManagerShim } from "@ace/provider-kit/discovery";

/**
 * The only directories a test run takes executables from wholesale: the operating system's own.
 * Everything else on the person's PATH (version-manager shims, ~/.local/bin, a Node install's
 * global bin) can hold a provider CLI, and a shim run under a test HOME installs its tool there.
 */
export const systemToolDirectories: readonly string[] = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/run/current-system/sw/bin",
  "/System/Cryptexes/App/usr/bin",
  "/Library/Apple/usr/bin",
];

/** Runtimes and toolchains tests start by name, taken from wherever the person keeps them. */
export const runtimeTools: readonly string[] = [
  "node",
  "npm",
  "npx",
  "bun",
  "bunx",
  "cargo",
  "rustc",
  "rustup",
  "rustfmt",
  "cargo-clippy",
  "clippy-driver",
];

/**
 * Agent CLIs and version managers a test must never reach, even from a system directory (a
 * Homebrew codex, an AUR claude). Tests that need a provider write a fake and name it.
 */
export const forbiddenTools: ReadonlySet<string> = new Set([
  "agent",
  "agy",
  "agy_acp_server",
  "amp",
  "antigravity",
  "auggie",
  "claude",
  "claude-agent-acp",
  "cline",
  "codex",
  "codex-acp",
  "commandcode",
  "copilot",
  "crush",
  "cursor-agent",
  "devin",
  "droid",
  "dsh",
  "freebuff",
  "gemini",
  "goose",
  "grok",
  "kilo",
  "kimi",
  "kiro-cli",
  "mcode",
  "muse",
  "omp",
  "opencode",
  "ori",
  "pi",
  "qwen",
  // Version managers: running one can install a tool.
  "asdf",
  "mise",
  "proto",
  "rtx",
  "volta",
]);

/** Whether a tool the run would link resolves to something a test may execute. */
export function allowedTool(name: string, path: string, target: string): boolean {
  return !forbiddenTools.has(name) && versionManagerShim(path, target) === undefined;
}

/**
 * Builds `directory` as the only PATH entry test processes get: links to the runtime tools and
 * to the system directories' executables, minus agent CLIs and shims. Returns the PATH value.
 * Windows can't link without privileges: see `prepareWindowsToolPath`.
 */
export async function prepareTestToolPath(
  directory: string,
  ambient: NodeJS.ProcessEnv,
  runtime = process.execPath,
  systemDirectories: readonly string[] = systemToolDirectories,
): Promise<string> {
  const path = ambient.PATH ?? ambient.Path ?? "";
  if (process.platform === "win32") {
    const { prepareWindowsToolPath } = await import("./test-tool-path-windows.ts");
    return prepareWindowsToolPath(
      directory,
      path,
      ambient.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      runtime,
    );
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const candidates: [name: string, path: string][] = [];
  // The runtime running the tests is always real, even when PATH only offers its shim.
  candidates.push([basename(runtime).replace(/\.exe$/, "") === "node" ? "node" : "bun", runtime]);
  for (const name of runtimeTools) {
    const found = await firstRealTool(name, path);
    if (found) candidates.push([name, found]);
  }
  // System directories in the person's PATH order, so the same `git` wins as in their shell.
  const systems = path.split(delimiter).filter((entry) => systemDirectories.includes(entry));
  for (const system of new Set(systems))
    for (const name of await readdir(system).catch(() => []))
      candidates.push([name, join(system, name)]);
  const targets = await Promise.all(
    candidates.map(async ([name, candidate]) => {
      const target = await realpath(candidate).catch(() => undefined);
      return target && (await npmEntry(name, target));
    }),
  );
  const links = new Map<string, string>();
  candidates.forEach(([name, candidate], index) => {
    const target = targets[index];
    if (!links.has(name) && target && allowedTool(name, candidate, target)) links.set(name, target);
  });
  await Promise.all([...links].map(([name, target]) => symlink(target, join(directory, name))));
  return directory;
}

/**
 * npm and npx as npm's own CLI scripts, which a standard Node install's `bin` links to. Some
 * installs put a wrapper there instead (mise's `npm` runs `mise reshim` after global installs)
 * that finds `node` beside its own path, so linked into the tool directory it finds none.
 */
async function npmEntry(name: string, target: string): Promise<string> {
  if (name !== "npm" && name !== "npx") return target;
  const cli = join(dirname(target), "../lib/node_modules/npm/bin", `${name}-cli.js`);
  return access(cli).then(
    () => realpath(cli),
    () => target,
  );
}

/** The first `name` on PATH that isn't a version manager's shim. */
async function firstRealTool(name: string, path: string): Promise<string | undefined> {
  for (const entry of path.split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const found = await findExecutable(name, { PATH: entry });
    if (!found) continue;
    const target = await realpath(found).catch(() => found);
    if (versionManagerShim(found, target) === undefined) return found;
  }
  return undefined;
}
