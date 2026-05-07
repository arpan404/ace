import { spawnSync } from "node:child_process";

import type { SpawnSyncReturns } from "node:child_process";

export const CODEX_GOAL_SLASH_COMMAND = {
  name: "goal",
  kind: "provider",
  description: "Set or inspect the active long-running goal",
  inputHint: "<objective>",
} as const;

const CODEX_FEATURE_CHECK_TIMEOUT_MS = 4_000;
const goalsFeatureEnabledByCacheKey = new Map<string, boolean>();

type SpawnSyncLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: Parameters<typeof spawnSync>[2],
) => SpawnSyncReturns<string>;

function cacheKeyForCodexGoalsFeature(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
  readonly launchEnv?: Readonly<Record<string, string>>;
}): string {
  const launchEnvEntries = Object.entries(input.launchEnv ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify({
    binaryPath: input.binaryPath,
    cwd: input.cwd,
    homePath: input.homePath ?? null,
    launchEnv: launchEnvEntries,
  });
}

export function parseCodexGoalsFeatureEnabled(output: string): boolean {
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns[0] === "goals") {
      return columns.at(-1) === "true";
    }
  }
  return false;
}

export function isCodexGoalsFeatureEnabled(
  input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
    readonly launchEnv?: Readonly<Record<string, string>>;
  },
  options?: {
    readonly spawnSync?: SpawnSyncLike;
  },
): boolean {
  const cacheKey = cacheKeyForCodexGoalsFeature(input);
  const cached = goalsFeatureEnabledByCacheKey.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const runSpawnSync = options?.spawnSync ?? spawnSync;
  const result = runSpawnSync(input.binaryPath, ["features", "list"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...input.launchEnv,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_FEATURE_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    goalsFeatureEnabledByCacheKey.set(cacheKey, false);
    return false;
  }

  const enabled = parseCodexGoalsFeatureEnabled(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  goalsFeatureEnabledByCacheKey.set(cacheKey, enabled);
  return enabled;
}

export function clearCodexGoalsFeatureCache(): void {
  goalsFeatureEnabledByCacheKey.clear();
}
