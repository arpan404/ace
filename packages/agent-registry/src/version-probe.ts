import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseCliVersion } from "@ace/provider-kit/cli-versions";

/*
 * The version ace records when the person approves an agent's update (ADR 0044 amendment, agents
 * that update themselves). It comes from ace's own reading of the approved files, never from
 * the person's client or the agent's `initialize` reply: the package an entry script ships in
 * (its `package.json`, whose `bin` names that script), else the approved executable's own
 * `--version`, run once at approval. Either is the artifact's claim, so a profile never counts
 * as verified on it (`versionSource: "probed"`).
 */

/** What a version probe may run: the approved launch, pinned when it is. */
export type VersionProbeTarget = Readonly<{
  command: string;
  /** Arguments before `--version`: a Windows script launch's script. */
  prefix: readonly string[];
  /** The approved file whose package metadata may name its version. */
  artifact: string;
  env: Readonly<NodeJS.ProcessEnv>;
}>;
/** Runs `command args` bounded, read-only, and returns what it printed. */
export type ProbeRunner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** What a version string of an agent's looks like, the first one in some output. */
const versionPattern = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/;

/** The first readable version in `text`, or undefined. */
export function readVersion(text: string): string | undefined {
  const found = versionPattern.exec(text)?.[0];
  return found && parseCliVersion(found) ? found : undefined;
}

/**
 * The version in the `package.json` of the package whose `bin` is `artifact`, looking at most
 * four folders up. Undefined when no package names it as a bin.
 */
export async function packageVersion(artifact: string): Promise<string | undefined> {
  const real = await realpath(artifact).catch(() => undefined);
  if (!real) return undefined;
  let folder = dirname(real);
  for (let depth = 0; depth < 4; depth++) {
    const text = await readFile(join(folder, "package.json"), "utf8").catch(() => undefined);
    if (text !== undefined && text.length <= 1024 * 1024) {
      const manifest = parseObject(text);
      if (manifest) {
        const bins = binPaths(manifest["bin"]);
        const named = await Promise.all(
          bins.map((bin) => realpath(resolve(folder, bin)).catch(() => undefined)),
        );
        const version = manifest["version"];
        if (named.includes(real) && typeof version === "string") return readVersion(version);
      }
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return undefined;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  } catch {
    return undefined;
  }
}

function binPaths(bin: unknown): string[] {
  if (typeof bin === "string") return [bin];
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) return [];
  return Object.values(bin).filter((value): value is string => typeof value === "string");
}

/**
 * The approved artifact's version as ace reads it, or `unknown` when nothing readable says. An
 * unknown version fits no profile, so the agent runs as generic ACP.
 */
export async function probeVersion(target: VersionProbeTarget, run: ProbeRunner): Promise<string> {
  const packaged = await packageVersion(target.artifact);
  if (packaged) return packaged;
  const output = await run(target.command, [...target.prefix, "--version"], {
    env: { ...target.env },
    timeoutMs: 4000,
    maxBytes: 64 * 1024,
  }).catch(() => undefined);
  if (output?.code !== 0) return "unknown";
  return readVersion(output.stdout) ?? readVersion(output.stderr) ?? "unknown";
}
