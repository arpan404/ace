import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import type { ProviderKind } from "@ace/contracts";
import { ServerProviderCliUpgradeError } from "@ace/contracts";
import { Effect } from "effect";

const CLI_UPGRADE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 4_000;

type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

interface UpgradePackage {
  readonly provider: ProviderKind;
  readonly runtimeId: string;
  readonly label: string;
  readonly packageName: string;
}

export interface CliUpgradePlan {
  readonly provider: ProviderKind;
  readonly runtimeId: string;
  readonly label: string;
  readonly packageManager: PackageManager;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const UPGRADE_PACKAGES: ReadonlyArray<UpgradePackage> = [
  {
    provider: "codex",
    runtimeId: "codex",
    label: "Codex",
    packageName: "@openai/codex",
  },
  {
    provider: "gemini",
    runtimeId: "gemini",
    label: "Gemini",
    packageName: "@google/gemini-cli",
  },
  {
    provider: "pi",
    runtimeId: "pi",
    label: "Pi",
    packageName: "@mariozechner/pi-coding-agent",
  },
] as const;

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

function upgradeArgs(packageManager: PackageManager, packageName: string): ReadonlyArray<string> {
  const packageSpec = `${packageName}@latest`;
  switch (packageManager) {
    case "bun":
      return ["add", "-g", packageSpec];
    case "pnpm":
      return ["add", "-g", packageSpec];
    case "yarn":
      return ["global", "add", packageSpec];
    case "npm":
      return ["install", "-g", packageSpec];
  }
}

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
      child.kill("SIGTERM");
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
  readonly resolvedBinaryPath: string | null;
}): CliUpgradePlan {
  const upgradePackage = UPGRADE_PACKAGES.find(
    (candidate) => candidate.provider === input.provider && candidate.runtimeId === input.runtimeId,
  );
  if (!upgradePackage) {
    throw new ServerProviderCliUpgradeError({
      message: "One-click upgrade is not supported for this provider.",
    });
  }

  const packageManager = detectPackageManager(input.resolvedBinaryPath);
  return {
    provider: upgradePackage.provider,
    runtimeId: upgradePackage.runtimeId,
    label: upgradePackage.label,
    packageManager,
    command: resolvePackageManagerCommand(packageManager, input.resolvedBinaryPath),
    args: upgradeArgs(packageManager, upgradePackage.packageName),
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
    resolvedBinaryPath,
  });
  const result = yield* Effect.tryPromise({
    try: () => runCommand(plan.command, plan.args, CLI_UPGRADE_TIMEOUT_MS),
    catch: (cause) =>
      new ServerProviderCliUpgradeError({
        message: `Unable to start ${plan.label} CLI upgrade with ${plan.packageManager}.`,
        cause,
      }),
  });

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
    command: [plan.command, ...plan.args].join(" "),
  };
});
