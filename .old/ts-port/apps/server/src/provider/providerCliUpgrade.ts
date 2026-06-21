import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import type { ProviderKind, ServerProvider, ServerProviderUpdateStatus } from "@ace/contracts";
import { ServerProviderCliUpgradeError } from "@ace/contracts";
import { terminateChildProcess } from "@ace/shared/processTermination";
import { Effect } from "effect";

import { compareCliVersions } from "./cliVersionRequirement";

const CLI_UPGRADE_TIMEOUT_MS = 5 * 60_000;
const CLI_VERSION_CHECK_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 4_000;

type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

type UpgradeDefinition =
  | {
      readonly kind: "package";
      readonly provider: ProviderKind;
      readonly runtimeId: string;
      readonly label: string;
      readonly packageName: string;
      readonly retryNpmForceOnBinConflict?: boolean;
    }
  | {
      readonly kind: "self";
      readonly provider: ProviderKind;
      readonly runtimeId: string;
      readonly label: string;
      readonly args: ReadonlyArray<string>;
    };

interface PackageCliUpgradePlan {
  readonly kind: "package";
  readonly provider: ProviderKind;
  readonly runtimeId: string;
  readonly label: string;
  readonly packageManager: PackageManager;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly fallback?: {
    readonly reason: "npm-bin-eexist";
    readonly args: ReadonlyArray<string>;
  };
}

interface SelfCliUpgradePlan {
  readonly kind: "self";
  readonly provider: ProviderKind;
  readonly runtimeId: string;
  readonly label: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export type CliUpgradePlan = PackageCliUpgradePlan | SelfCliUpgradePlan;

const UPGRADE_DEFINITIONS: ReadonlyArray<UpgradeDefinition> = [
  {
    kind: "package",
    provider: "codex",
    runtimeId: "codex",
    label: "Codex",
    packageName: "@openai/codex",
  },
  {
    kind: "package",
    provider: "claudeAgent",
    runtimeId: "claudeAgent",
    label: "Claude",
    packageName: "@anthropic-ai/claude-code",
  },
  {
    kind: "package",
    provider: "githubCopilot",
    runtimeId: "githubCopilot",
    label: "GitHub Copilot",
    packageName: "@github/copilot",
    retryNpmForceOnBinConflict: true,
  },
  {
    kind: "self",
    provider: "cursor",
    runtimeId: "cursor",
    label: "Cursor Agent",
    args: ["update"],
  },
  {
    kind: "package",
    provider: "pi",
    runtimeId: "pi",
    label: "Pi",
    packageName: "@mariozechner/pi-coding-agent",
  },
  {
    kind: "package",
    provider: "gemini",
    runtimeId: "gemini",
    label: "Gemini",
    packageName: "@google/gemini-cli",
  },
  {
    kind: "self",
    provider: "opencode",
    runtimeId: "opencode",
    label: "OpenCode",
    args: ["upgrade"],
  },
] as const;

function findUpgradeDefinition(
  provider: ProviderKind,
  runtimeId: string,
): UpgradeDefinition | undefined {
  return UPGRADE_DEFINITIONS.find(
    (candidate) => candidate.provider === provider && candidate.runtimeId === runtimeId,
  );
}

function truncateOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= OUTPUT_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, OUTPUT_LIMIT)}...`;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function detectPackageManager(binaryPath: string | null): PackageManager {
  const normalized = (binaryPath ?? "").replaceAll("\\", "/");
  if (normalized.includes("/.bun/bin/")) {
    return "bun";
  }
  if (normalized.includes("/.local/share/pnpm/") || normalized.includes("/pnpm/")) {
    return "pnpm";
  }
  if (normalized.includes("/.yarn/bin/") || normalized.includes("/yarn/")) {
    return "yarn";
  }
  return "npm";
}

function resolvePackageManagerCommand(
  packageManager: PackageManager,
  binaryPath: string | null,
): string {
  if (packageManager === "bun" && binaryPath) {
    return join(dirname(binaryPath), process.platform === "win32" ? "bun.exe" : "bun");
  }
  return packageManager;
}

function upgradeArgs(
  packageManager: PackageManager,
  packageName: string,
  options?: { readonly force?: boolean },
): ReadonlyArray<string> {
  const packageSpec = `${packageName}@latest`;
  switch (packageManager) {
    case "bun":
      return ["add", "-g", packageSpec];
    case "pnpm":
      return ["add", "-g", packageSpec];
    case "yarn":
      return ["global", "add", packageSpec];
    case "npm":
      return ["install", "-g", ...(options?.force ? ["--force"] : []), packageSpec];
  }
}

function isNpmBinExistsConflict(result: { readonly stdout: string; readonly stderr: string }) {
  const output = `${result.stderr}\n${result.stdout}`;
  return /\bEEXIST\b/iu.test(output) && /(?:file exists|already exists)/iu.test(output);
}

function parseNpmLatestVersionOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" && parsed.trim().length > 0 ? parsed.trim() : null;
  } catch {
    return (
      trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .toReversed()
        .find((line) => line.length > 0) ?? null
    );
  }
}

export function resolveProviderCliUpdateStatus(input: {
  readonly version: string | null;
  readonly latestVersion: string | null;
}): ServerProviderUpdateStatus {
  if (!input.version || !input.latestVersion) {
    return "unknown";
  }
  return compareCliVersions(input.latestVersion, input.version) > 0
    ? "update-available"
    : "up-to-date";
}

const checkLatestPackageVersion = Effect.fn("checkLatestPackageVersion")(function* (
  packageName: string,
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      runCommand("npm", ["view", packageName, "version", "--json"], CLI_VERSION_CHECK_TIMEOUT_MS),
    catch: (cause) =>
      new ServerProviderCliUpgradeError({
        message: `Unable to check latest CLI version for ${packageName}.`,
        cause,
      }),
  }).pipe(Effect.orElseSucceed(() => null));
  if (!result || result.code !== 0) {
    return null;
  }
  return parseNpmLatestVersionOutput(result.stdout);
});

const withProviderCliUpdateStatus = Effect.fn("withProviderCliUpdateStatus")(function* (
  provider: ServerProvider,
) {
  const defaultDefinition = findUpgradeDefinition(provider.provider, provider.provider);
  const latestVersion =
    provider.installed && defaultDefinition?.kind === "package"
      ? yield* checkLatestPackageVersion(defaultDefinition.packageName)
      : null;
  const updateStatus = resolveProviderCliUpdateStatus({
    version: provider.version,
    latestVersion,
  });
  const runtimes = yield* Effect.all(
    (provider.runtimes ?? []).map((runtime) =>
      Effect.gen(function* () {
        const runtimeDefinition = findUpgradeDefinition(provider.provider, runtime.id);
        const runtimeLatestVersion =
          runtime.installed && runtimeDefinition?.kind === "package"
            ? yield* checkLatestPackageVersion(runtimeDefinition.packageName)
            : null;
        return {
          ...runtime,
          latestVersion: runtimeLatestVersion,
          updateStatus: resolveProviderCliUpdateStatus({
            version: runtime.version,
            latestVersion: runtimeLatestVersion,
          }),
        };
      }),
    ),
    { concurrency: 3 },
  );

  return {
    ...provider,
    latestVersion,
    updateStatus,
    ...(provider.runtimes ? { runtimes } : {}),
  };
});

export const withProviderCliUpdateStatuses = Effect.fn("withProviderCliUpdateStatuses")(function* (
  providers: ReadonlyArray<ServerProvider>,
) {
  return yield* Effect.all(providers.map(withProviderCliUpdateStatus), { concurrency: 3 });
});

function shellCommandForPathLookup(binaryPath: string): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  if (process.platform === "win32") {
    return { command: "where.exe", args: [binaryPath] };
  }
  return { command: "which", args: [binaryPath] };
}

function runCommand(command: string, args: ReadonlyArray<string>, timeoutMs: number) {
  return new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
  }>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: process.platform === "win32",
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      terminateChildProcess(child, { signal: "SIGTERM", tree: true });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code, signal });
    });
  });
}

export function buildProviderCliUpgradePlan(input: {
  readonly provider: ProviderKind;
  readonly runtimeId: string;
  readonly binaryPath?: string;
  readonly resolvedBinaryPath: string | null;
}): CliUpgradePlan {
  const upgradeDefinition = findUpgradeDefinition(input.provider, input.runtimeId);
  if (!upgradeDefinition) {
    throw new ServerProviderCliUpgradeError({
      message: "One-click upgrade is not supported for this provider.",
    });
  }

  if (upgradeDefinition.kind === "self") {
    return {
      kind: "self",
      provider: upgradeDefinition.provider,
      runtimeId: upgradeDefinition.runtimeId,
      label: upgradeDefinition.label,
      command: input.resolvedBinaryPath ?? input.binaryPath ?? upgradeDefinition.runtimeId,
      args: upgradeDefinition.args,
    };
  }

  const packageManager = detectPackageManager(input.resolvedBinaryPath);
  const fallback =
    packageManager === "npm" && upgradeDefinition.retryNpmForceOnBinConflict === true
      ? {
          reason: "npm-bin-eexist" as const,
          args: upgradeArgs(packageManager, upgradeDefinition.packageName, { force: true }),
        }
      : undefined;

  return {
    kind: "package",
    provider: upgradeDefinition.provider,
    runtimeId: upgradeDefinition.runtimeId,
    label: upgradeDefinition.label,
    packageManager,
    command: resolvePackageManagerCommand(packageManager, input.resolvedBinaryPath),
    args: upgradeArgs(packageManager, upgradeDefinition.packageName),
    ...(fallback ? { fallback } : {}),
  };
}

export const resolveProviderBinaryPath = Effect.fn("resolveProviderBinaryPath")(function* (
  binaryPath: string,
) {
  if (hasPathSeparator(binaryPath)) {
    return binaryPath;
  }

  const lookup = shellCommandForPathLookup(binaryPath);
  const result = yield* Effect.tryPromise({
    try: () => runCommand(lookup.command, lookup.args, 10_000),
    catch: (cause) =>
      new ServerProviderCliUpgradeError({
        message: `Unable to resolve '${binaryPath}' on PATH.`,
        cause,
      }),
  });
  if (result.code !== 0) {
    return null;
  }
  return (
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
});

export const upgradeProviderCli = Effect.fn("upgradeProviderCli")(function* (input: {
  readonly provider: ProviderKind;
  readonly runtimeId: string;
  readonly binaryPath: string;
}) {
  const resolvedBinaryPath = yield* resolveProviderBinaryPath(input.binaryPath);
  const plan = buildProviderCliUpgradePlan({
    provider: input.provider,
    runtimeId: input.runtimeId,
    binaryPath: input.binaryPath,
    resolvedBinaryPath,
  });
  const runUpgradePlanCommand = (args: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () => runCommand(plan.command, args, CLI_UPGRADE_TIMEOUT_MS),
      catch: (cause) =>
        new ServerProviderCliUpgradeError({
          message:
            plan.kind === "package"
              ? `Unable to start ${plan.label} CLI upgrade with ${plan.packageManager}.`
              : `Unable to start ${plan.label} CLI self-update.`,
          cause,
        }),
    });

  let args = plan.args;
  let result = yield* runUpgradePlanCommand(args);
  if (
    result.code !== 0 &&
    plan.kind === "package" &&
    plan.fallback?.reason === "npm-bin-eexist" &&
    isNpmBinExistsConflict(result)
  ) {
    args = plan.fallback.args;
    result = yield* runUpgradePlanCommand(args);
  }

  if (result.code !== 0) {
    const detail = truncateOutput(result.stderr || result.stdout);
    return yield* new ServerProviderCliUpgradeError({
      message: detail
        ? `${plan.label} CLI upgrade failed: ${detail}`
        : `${plan.label} CLI upgrade failed with code ${String(result.code)}.`,
    });
  }

  return {
    provider: plan.provider,
    runtimeId: plan.runtimeId,
    command: [plan.command, ...args].join(" "),
  };
});
