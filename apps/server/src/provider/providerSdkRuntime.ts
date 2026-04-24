import { join } from "node:path";

import {
  assertNpmAvailable,
  installPackagesWithNpm,
  loadInstalledModule,
  readInstalledPackageVersion,
} from "../runtimePackageManager";

export interface GitHubCopilotSdkModule {
  readonly CopilotClient: typeof import("@github/copilot-sdk").CopilotClient;
}

export interface ClaudeAgentSdkModule {
  readonly query: typeof import("@anthropic-ai/claude-agent-sdk").query;
}

export type GitHubCopilotSdkLoader = () => Promise<GitHubCopilotSdkModule>;
export type ClaudeAgentSdkLoader = () => Promise<ClaudeAgentSdkModule>;

const PROVIDER_RUNTIME_ROOT_DIRNAME = "provider-sdk";
const GITHUB_COPILOT_SDK_PACKAGE = {
  name: "@github/copilot-sdk",
  version: "0.2.0",
} as const;
const CLAUDE_AGENT_SDK_PACKAGE = {
  name: "@anthropic-ai/claude-agent-sdk",
  version: "0.2.77",
} as const;

const installDirPromiseCache = new Map<string, Promise<string>>();
const modulePromiseCache = new Map<string, Promise<unknown>>();

function providerRuntimeInstallDir(stateDir: string, provider: string): string {
  return join(stateDir, PROVIDER_RUNTIME_ROOT_DIRNAME, provider);
}

function isModuleMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    (typeof (error as { code?: unknown }).code === "string" &&
      (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") ||
    error.message.includes("Cannot find package") ||
    error.message.includes("Cannot find module")
  );
}

async function tryImportLocalModule<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    if (isModuleMissingError(error)) {
      return null;
    }
    throw error;
  }
}

function normalizeGitHubCopilotSdkModule(module: Record<string, unknown>): GitHubCopilotSdkModule {
  const candidate =
    module.CopilotClient ??
    ((typeof module.default === "object" &&
    module.default !== null &&
    "CopilotClient" in module.default
      ? (module.default as { CopilotClient?: unknown }).CopilotClient
      : undefined) as unknown);
  if (typeof candidate !== "function") {
    throw new Error("Installed GitHub Copilot SDK does not export CopilotClient.");
  }
  return {
    CopilotClient: candidate as GitHubCopilotSdkModule["CopilotClient"],
  };
}

function normalizeClaudeAgentSdkModule(module: Record<string, unknown>): ClaudeAgentSdkModule {
  const candidate =
    module.query ??
    ((typeof module.default === "object" && module.default !== null && "query" in module.default
      ? (module.default as { query?: unknown }).query
      : undefined) as unknown);
  if (typeof candidate !== "function") {
    throw new Error("Installed Claude Agent SDK does not export query.");
  }
  return {
    query: candidate as ClaudeAgentSdkModule["query"],
  };
}

async function ensureProviderSdkInstalled(
  stateDir: string,
  provider: string,
  packageSpec: { readonly name: string; readonly version: string },
): Promise<string> {
  const installDir = providerRuntimeInstallDir(stateDir, provider);
  const cacheKey = `${installDir}:${packageSpec.name}@${packageSpec.version}`;
  const cached = installDirPromiseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pendingInstall = (async () => {
    const installedVersion = await readInstalledPackageVersion(installDir, packageSpec.name);
    if (installedVersion === packageSpec.version) {
      return installDir;
    }
    assertNpmAvailable(
      `Cannot install ${provider} runtime dependencies because npm is not available in PATH.`,
    );
    await installPackagesWithNpm({
      installDir,
      packageJsonName: `ace-provider-runtime-${provider}`,
      packages: [`${packageSpec.name}@${packageSpec.version}`],
    });
    return installDir;
  })();

  installDirPromiseCache.set(cacheKey, pendingInstall);
  try {
    return await pendingInstall;
  } catch (error) {
    installDirPromiseCache.delete(cacheKey);
    throw error;
  }
}

export async function loadGitHubCopilotSdkModule(
  stateDir: string,
): Promise<GitHubCopilotSdkModule> {
  const cacheKey = `githubCopilot:${stateDir}`;
  const cached = modulePromiseCache.get(cacheKey);
  if (cached) {
    return (await cached) as GitHubCopilotSdkModule;
  }

  const pendingModule = (async () => {
    const localModule = await tryImportLocalModule<Record<string, unknown>>("@github/copilot-sdk");
    if (localModule) {
      return normalizeGitHubCopilotSdkModule(localModule);
    }
    const installDir = await ensureProviderSdkInstalled(
      stateDir,
      "github-copilot",
      GITHUB_COPILOT_SDK_PACKAGE,
    );
    const installedModule = await loadInstalledModule<Record<string, unknown>>(
      installDir,
      "@github/copilot-sdk",
    );
    return normalizeGitHubCopilotSdkModule(installedModule);
  })();

  modulePromiseCache.set(cacheKey, pendingModule);
  try {
    return await pendingModule;
  } catch (error) {
    modulePromiseCache.delete(cacheKey);
    throw error;
  }
}

export async function loadClaudeAgentSdkModule(stateDir: string): Promise<ClaudeAgentSdkModule> {
  const cacheKey = `claudeAgent:${stateDir}`;
  const cached = modulePromiseCache.get(cacheKey);
  if (cached) {
    return (await cached) as ClaudeAgentSdkModule;
  }

  const pendingModule = (async () => {
    const localModule = await tryImportLocalModule<Record<string, unknown>>(
      "@anthropic-ai/claude-agent-sdk",
    );
    if (localModule) {
      return normalizeClaudeAgentSdkModule(localModule);
    }
    const installDir = await ensureProviderSdkInstalled(
      stateDir,
      "claude-agent",
      CLAUDE_AGENT_SDK_PACKAGE,
    );
    const installedModule = await loadInstalledModule<Record<string, unknown>>(
      installDir,
      "@anthropic-ai/claude-agent-sdk",
    );
    return normalizeClaudeAgentSdkModule(installedModule);
  })();

  modulePromiseCache.set(cacheKey, pendingModule);
  try {
    return await pendingModule;
  } catch (error) {
    modulePromiseCache.delete(cacheKey);
    throw error;
  }
}
