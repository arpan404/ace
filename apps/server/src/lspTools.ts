import { access, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type {
  ServerInstallLspToolInput,
  ServerLspMarketplacePackage,
  ServerLspMarketplaceSearchResult,
  ServerLspToolStatus,
  ServerLspToolsStatus,
} from "@ace/contracts";

import { isCommandAvailable } from "./open";
import { runProcess } from "./processRunner";
import {
  ensurePackageInstallRoot,
  installPackagesWithNpm as installRuntimePackagesWithNpm,
  readInstalledPackageVersion,
} from "./runtimePackageManager";

interface LspToolDefinition {
  readonly id: string;
  readonly packageName: string;
  readonly command: string;
  readonly label: string;
  readonly args: readonly string[];
  readonly languageIds: readonly string[];
  readonly fileExtensions: readonly string[];
  readonly builtin: boolean;
}

interface SerializedLspToolDefinition {
  readonly id: string;
  readonly packageName: string;
  readonly command: string;
  readonly label: string;
  readonly args: readonly string[];
  readonly languageIds: readonly string[];
  readonly fileExtensions: readonly string[];
}

interface SerializedLspRegistry {
  readonly version: 1;
  readonly tools: readonly SerializedLspToolDefinition[];
}

export interface RuntimeLspServerDefinition {
  readonly id: string;
  readonly packageName: string;
  readonly command: string;
  readonly label: string;
  readonly args: readonly string[];
  readonly languageIds: ReadonlySet<string>;
  readonly fileExtensions: ReadonlySet<string>;
  readonly builtin: boolean;
}

const BUILTIN_LSP_TOOL_DEFINITIONS: readonly LspToolDefinition[] = [
  {
    id: "typescript-language-server",
    packageName: "typescript-language-server",
    command: "typescript-language-server",
    label: "TypeScript / JavaScript",
    args: ["--stdio"],
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    fileExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    builtin: true,
  },
  {
    id: "vscode-json-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-json-language-server",
    label: "JSON",
    args: ["--stdio"],
    languageIds: ["json"],
    fileExtensions: [".json"],
    builtin: true,
  },
  {
    id: "vscode-css-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-css-language-server",
    label: "CSS",
    args: ["--stdio"],
    languageIds: ["css", "scss", "less"],
    fileExtensions: [".css", ".scss", ".less"],
    builtin: true,
  },
  {
    id: "vscode-html-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-html-language-server",
    label: "HTML",
    args: ["--stdio"],
    languageIds: ["html"],
    fileExtensions: [".html", ".htm"],
    builtin: true,
  },
] as const;

const BUILTIN_LSP_PACKAGE_VERSION_BY_NAME = {
  typescript: "^5.9.2",
  "typescript-language-server": "^5.0.1",
  "vscode-langservers-extracted": "^4.10.0",
} as const;

const LSP_REGISTRY_FILENAME = "registry.json";

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeLanguageId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeServerArgs(args: readonly string[] | undefined): readonly string[] {
  if (!args) {
    return ["--stdio"];
  }
  const next = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  return next.length > 0 ? next : ["--stdio"];
}

function normalizeDefinition(
  definition: Omit<LspToolDefinition, "builtin"> & { readonly builtin?: boolean },
): LspToolDefinition | null {
  const id = definition.id.trim();
  const packageName = definition.packageName.trim();
  const command = definition.command.trim();
  const label = definition.label.trim();
  if (id.length === 0 || packageName.length === 0 || command.length === 0 || label.length === 0) {
    return null;
  }

  const languageIds = Array.from(
    new Set(definition.languageIds.map(normalizeLanguageId).filter((value) => value.length > 0)),
  );
  const fileExtensions = Array.from(
    new Set(
      definition.fileExtensions
        .map(normalizeExtension)
        .filter((value) => value.length > 1 && extname(`index${value}`) === value),
    ),
  );
  if (languageIds.length === 0 || fileExtensions.length === 0) {
    return null;
  }

  return {
    id,
    packageName,
    command,
    label,
    args: normalizeServerArgs(definition.args),
    languageIds,
    fileExtensions,
    builtin: definition.builtin ?? false,
  };
}

function toRuntimeServerDefinition(definition: LspToolDefinition): RuntimeLspServerDefinition {
  return {
    ...definition,
    languageIds: new Set(definition.languageIds),
    fileExtensions: new Set(definition.fileExtensions),
  };
}

function resolveInstallDir(stateDir: string): string {
  return join(stateDir, "lsp-tools");
}

function resolveBinDir(stateDir: string): string {
  return join(resolveInstallDir(stateDir), "node_modules", ".bin");
}

function resolveRegistryPath(stateDir: string): string {
  return join(resolveInstallDir(stateDir), LSP_REGISTRY_FILENAME);
}

async function isPathExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureInstallRoot(installDir: string): Promise<void> {
  await ensurePackageInstallRoot(installDir, "ace-lsp-tools");
}

async function readCustomRegistry(stateDir: string): Promise<readonly LspToolDefinition[]> {
  const registryPath = resolveRegistryPath(stateDir);
  try {
    const raw = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as SerializedLspRegistry;
    if (parsed.version !== 1 || !Array.isArray(parsed.tools)) {
      return [];
    }
    return parsed.tools
      .map((tool) =>
        normalizeDefinition({
          ...tool,
          builtin: false,
        }),
      )
      .filter((tool): tool is LspToolDefinition => tool !== null);
  } catch {
    return [];
  }
}

async function writeCustomRegistry(
  stateDir: string,
  tools: readonly LspToolDefinition[],
): Promise<void> {
  const installDir = resolveInstallDir(stateDir);
  await ensureInstallRoot(installDir);
  const payload: SerializedLspRegistry = {
    version: 1,
    tools: tools
      .filter((tool) => !tool.builtin)
      .map((tool) => ({
        id: tool.id,
        packageName: tool.packageName,
        command: tool.command,
        label: tool.label,
        args: tool.args,
        languageIds: tool.languageIds,
        fileExtensions: tool.fileExtensions,
      })),
  };
  await writeFile(resolveRegistryPath(stateDir), JSON.stringify(payload, null, 2), "utf8");
}

export async function getLspToolDefinitions(
  stateDir: string,
): Promise<readonly LspToolDefinition[]> {
  const customTools = await readCustomRegistry(stateDir);
  const byId = new Map<string, LspToolDefinition>();
  for (const builtin of BUILTIN_LSP_TOOL_DEFINITIONS) {
    byId.set(builtin.id, builtin);
  }
  for (const custom of customTools) {
    byId.set(custom.id, custom);
  }
  return [...byId.values()];
}

export async function getLspServerRegistry(
  stateDir: string,
): Promise<readonly RuntimeLspServerDefinition[]> {
  const tools = await getLspToolDefinitions(stateDir);
  return tools.map(toRuntimeServerDefinition);
}

export async function getLspToolsStatus(stateDir: string): Promise<ServerLspToolsStatus> {
  const installDir = resolveInstallDir(stateDir);
  const commandSuffix = process.platform === "win32" ? ".cmd" : "";
  const definitions = await getLspToolDefinitions(stateDir);

  const tools: ServerLspToolStatus[] = await Promise.all(
    definitions.map(async (tool) => {
      const binaryPath = join(resolveBinDir(stateDir), `${tool.command}${commandSuffix}`);
      const installed = await isPathExecutable(binaryPath);
      const version = await readInstalledPackageVersion(installDir, tool.packageName);
      return {
        id: tool.id,
        label: tool.label,
        command: tool.command,
        args: [...tool.args],
        packageName: tool.packageName,
        languageIds: [...tool.languageIds],
        fileExtensions: [...tool.fileExtensions],
        builtin: tool.builtin,
        installed,
        version,
        binaryPath: installed ? binaryPath : null,
      };
    }),
  );

  return {
    installDir,
    tools,
  };
}

async function installPackagesWithNpm(
  stateDir: string,
  packages: readonly string[],
  options: { readonly reinstall?: boolean } = {},
): Promise<void> {
  const installDir = resolveInstallDir(stateDir);
  await installRuntimePackagesWithNpm({
    installDir,
    packageJsonName: "ace-lsp-tools",
    packages,
    ...(options.reinstall !== undefined ? { reinstall: options.reinstall } : {}),
  });
}

export async function installLspTools(
  stateDir: string,
  options: { readonly reinstall?: boolean } = {},
): Promise<ServerLspToolsStatus> {
  if (!isCommandAvailable("npm")) {
    throw new Error("Cannot install language servers because npm is not available in PATH.");
  }
  const packages = Object.entries(BUILTIN_LSP_PACKAGE_VERSION_BY_NAME).map(
    ([name, version]) => `${name}@${version}`,
  );
  await installPackagesWithNpm(stateDir, packages, options);
  return getLspToolsStatus(stateDir);
}

export async function searchLspMarketplace(
  query: string,
  limit: number,
): Promise<ServerLspMarketplaceSearchResult> {
  const normalizedQuery = query.trim();
  if (!isCommandAvailable("npm")) {
    throw new Error("Cannot search language servers because npm is not available in PATH.");
  }
  if (normalizedQuery.length === 0) {
    return { query: normalizedQuery, packages: [] };
  }
  const searchLimit = Math.max(1, Math.min(limit, 50));
  const result = await runProcess(
    "npm",
    ["search", "--json", "--searchlimit", String(searchLimit), normalizedQuery],
    {
      timeoutMs: 30_000,
      maxBufferBytes: 4 * 1024 * 1024,
      outputMode: "truncate",
      allowNonZeroExit: true,
    },
  );
  let packages: ServerLspMarketplacePackage[] = [];
  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      name?: unknown;
      description?: unknown;
      version?: unknown;
      keywords?: unknown;
    }>;
    packages = parsed
      .flatMap((entry): ServerLspMarketplacePackage[] => {
        const packageName =
          typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : null;
        if (!packageName) {
          return [];
        }
        const description =
          typeof entry.description === "string" && entry.description.trim().length > 0
            ? entry.description.trim()
            : null;
        const version =
          typeof entry.version === "string" && entry.version.trim().length > 0
            ? entry.version.trim()
            : null;
        const keywords = Array.isArray(entry.keywords)
          ? entry.keywords
              .map((keyword) => (typeof keyword === "string" ? keyword.trim() : ""))
              .filter((keyword) => keyword.length > 0)
          : [];
        return [
          {
            packageName,
            description,
            version,
            keywords,
          },
        ];
      })
      .filter((pkg) => {
        const haystack = [
          pkg.packageName.toLowerCase(),
          (pkg.description ?? "").toLowerCase(),
          ...pkg.keywords.map((keyword) => keyword.toLowerCase()),
        ];
        return haystack.some(
          (value) =>
            value.includes("language server") ||
            value.includes("lsp") ||
            value.includes("langserver"),
        );
      })
      .slice(0, searchLimit);
  } catch {
    packages = [];
  }
  return {
    query: normalizedQuery,
    packages,
  };
}

export async function installLspTool(
  stateDir: string,
  input: ServerInstallLspToolInput,
): Promise<ServerLspToolsStatus> {
  if (!isCommandAvailable("npm")) {
    throw new Error("Cannot install language servers because npm is not available in PATH.");
  }

  const packageName = input.packageName.trim();
  const command = input.command.trim();
  const label = input.label.trim();
  const languageIds = Array.from(
    new Set(input.languageIds.map(normalizeLanguageId).filter((value) => value.length > 0)),
  );
  const fileExtensions = Array.from(
    new Set(input.fileExtensions.map(normalizeExtension).filter((value) => value.length > 1)),
  );
  if (packageName.length === 0 || command.length === 0 || label.length === 0) {
    throw new Error("Package name, command, and label are required to install a language server.");
  }
  if (languageIds.length === 0 || fileExtensions.length === 0) {
    throw new Error("At least one language id and file extension are required.");
  }

  const installOptions = input.reinstall === undefined ? {} : { reinstall: input.reinstall };
  await installPackagesWithNpm(stateDir, [packageName], installOptions);

  const existingTools = await getLspToolDefinitions(stateDir);
  const id = command;
  const customTools = existingTools.filter((tool) => !tool.builtin && tool.id !== id);
  const normalized = normalizeDefinition({
    id,
    packageName,
    command,
    label,
    args: normalizeServerArgs(input.args),
    languageIds,
    fileExtensions,
    builtin: false,
  });
  if (!normalized) {
    throw new Error("Unable to register the language server due to invalid metadata.");
  }
  await writeCustomRegistry(stateDir, [...customTools, normalized]);
  return getLspToolsStatus(stateDir);
}
