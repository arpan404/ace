import { access, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

import type {
  ServerInstallLspToolInput,
  ServerLspMarketplaceSearchResult,
  ServerLspToolInstaller,
  ServerLspToolStatus,
  ServerLspToolsStatus,
} from "@ace/contracts";

import { isCommandAvailable } from "./open";
import { runProcess } from "./processRunner";
import {
  ensurePackageInstallRoot,
  installPackagesWithGoInstall,
  installPackagesWithNpm as installRuntimePackagesWithNpm,
  installPackagesWithUvTool,
  readInstalledPackageVersion,
} from "./runtimePackageManager";

type LspToolCategory = ServerLspToolStatus["category"];
type LspToolSource = ServerLspToolStatus["source"];
type LspToolInstaller = ServerLspToolStatus["installer"];

interface LspToolDefinition {
  readonly id: string;
  readonly packageName: string;
  readonly command: string;
  readonly label: string;
  readonly description: string;
  readonly installer: LspToolInstaller;
  readonly args: readonly string[];
  readonly installPackages: readonly string[];
  readonly tags: readonly string[];
  readonly languageIds: readonly string[];
  readonly fileExtensions: readonly string[];
  readonly fileNames: readonly string[];
  readonly languageIdByExtension: Readonly<Record<string, string>>;
  readonly builtin: boolean;
  readonly source: LspToolSource;
  readonly category: LspToolCategory;
  readonly envBinKey?: string;
  readonly envArgsJsonKey?: string;
}

interface SerializedLspToolDefinition {
  readonly id: string;
  readonly packageName: string;
  readonly command: string;
  readonly label: string;
  readonly installer?: LspToolInstaller;
  readonly description?: string;
  readonly args: readonly string[];
  readonly installPackages?: readonly string[];
  readonly languageIds: readonly string[];
  readonly fileExtensions: readonly string[];
  readonly fileNames?: readonly string[];
}

interface SerializedLspRegistry {
  readonly version: 1 | 2 | 3;
  readonly tools: readonly SerializedLspToolDefinition[];
}

export interface RuntimeLspServerDefinition {
  readonly id: string;
  readonly packageName: string;
  readonly command: string;
  readonly installer: LspToolInstaller;
  readonly args: readonly string[];
  readonly languageIds: ReadonlySet<string>;
  readonly fileExtensions: ReadonlySet<string>;
  readonly fileNames: ReadonlySet<string>;
  readonly languageIdByExtension: ReadonlyMap<string, string>;
  readonly builtin: boolean;
  readonly source: LspToolSource;
  readonly envBinKey?: string;
  readonly envArgsJsonKey?: string;
}

const CORE_LSP_TOOL_DEFINITIONS: readonly LspToolDefinition[] = [
  {
    id: "typescript-language-server",
    packageName: "typescript-language-server",
    command: "typescript-language-server",
    label: "TypeScript / JavaScript",
    description: "Core IntelliSense for TypeScript, JavaScript, JSX, and TSX workspaces.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["typescript@6.0.3", "typescript-language-server@5.1.3"],
    tags: ["typescript", "javascript", "react", "tsx", "jsx"],
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    fileExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    fileNames: [],
    languageIdByExtension: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    builtin: true,
    source: "builtin",
    category: "core",
    envBinKey: "ACE_LSP_TYPESCRIPT_SERVER_BIN",
    envArgsJsonKey: "ACE_LSP_TYPESCRIPT_SERVER_ARGS_JSON",
  },
  {
    id: "vscode-json-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-json-language-server",
    label: "JSON",
    description: "Schemas, validation, and completion for JSON configuration files.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["vscode-langservers-extracted@4.10.0"],
    tags: ["json", "config", "schemas"],
    languageIds: ["json"],
    fileExtensions: [".json"],
    fileNames: [],
    languageIdByExtension: {},
    builtin: true,
    source: "builtin",
    category: "core",
    envBinKey: "ACE_LSP_JSON_SERVER_BIN",
    envArgsJsonKey: "ACE_LSP_JSON_SERVER_ARGS_JSON",
  },
  {
    id: "vscode-css-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-css-language-server",
    label: "CSS",
    description: "Autocomplete and diagnostics for CSS, SCSS, and Less stylesheets.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["vscode-langservers-extracted@4.10.0"],
    tags: ["css", "scss", "less", "styles"],
    languageIds: ["css", "scss", "less"],
    fileExtensions: [".css", ".scss", ".less"],
    fileNames: [],
    languageIdByExtension: {
      ".scss": "scss",
      ".less": "less",
    },
    builtin: true,
    source: "builtin",
    category: "core",
    envBinKey: "ACE_LSP_CSS_SERVER_BIN",
    envArgsJsonKey: "ACE_LSP_CSS_SERVER_ARGS_JSON",
  },
  {
    id: "vscode-html-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-html-language-server",
    label: "HTML",
    description: "Core HTML diagnostics and completion for templates and static pages.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["vscode-langservers-extracted@4.10.0"],
    tags: ["html", "templates", "markup"],
    languageIds: ["html"],
    fileExtensions: [".html", ".htm"],
    fileNames: [],
    languageIdByExtension: {},
    builtin: true,
    source: "builtin",
    category: "core",
    envBinKey: "ACE_LSP_HTML_SERVER_BIN",
    envArgsJsonKey: "ACE_LSP_HTML_SERVER_ARGS_JSON",
  },
  {
    id: "vscode-markdown-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-markdown-language-server",
    label: "Markdown",
    description: "Link validation and authoring assistance for Markdown content.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["vscode-langservers-extracted@4.10.0"],
    tags: ["markdown", "md", "docs"],
    languageIds: ["markdown"],
    fileExtensions: [".md", ".markdown"],
    fileNames: [],
    languageIdByExtension: {
      ".markdown": "markdown",
    },
    builtin: true,
    source: "builtin",
    category: "markup",
  },
] as const;

const CURATED_LSP_TOOL_DEFINITIONS: readonly LspToolDefinition[] = [
  {
    id: "yaml-language-server",
    packageName: "yaml-language-server",
    command: "yaml-language-server",
    label: "YAML",
    description: "Schema-aware validation and completion for YAML infrastructure and config files.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["yaml-language-server@1.22.0"],
    tags: ["yaml", "config", "kubernetes", "github-actions"],
    languageIds: ["yaml"],
    fileExtensions: [".yaml", ".yml"],
    fileNames: [],
    languageIdByExtension: {
      ".yml": "yaml",
    },
    builtin: false,
    source: "catalog",
    category: "config",
  },
  {
    id: "tailwindcss-language-server",
    packageName: "@tailwindcss/language-server",
    command: "tailwindcss-language-server",
    label: "Tailwind CSS",
    description: "Utility-class completions and diagnostics for Tailwind-driven frontend projects.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["@tailwindcss/language-server@0.14.29"],
    tags: ["tailwind", "css", "frontend", "utility-classes"],
    languageIds: ["html", "css", "javascriptreact", "typescriptreact", "vue", "svelte"],
    fileExtensions: [".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"],
    fileNames: [],
    languageIdByExtension: {
      ".html": "html",
      ".css": "css",
      ".js": "javascriptreact",
      ".jsx": "javascriptreact",
      ".ts": "typescriptreact",
      ".tsx": "typescriptreact",
      ".vue": "vue",
      ".svelte": "svelte",
    },
    builtin: false,
    source: "catalog",
    category: "framework",
  },
  {
    id: "bash-language-server",
    packageName: "bash-language-server",
    command: "bash-language-server",
    label: "Shell / Bash",
    description: "Shell script diagnostics and navigation for bash and zsh-flavored scripts.",
    installer: "npm",
    args: ["start"],
    installPackages: ["bash-language-server@5.6.0"],
    tags: ["bash", "shell", "zsh", "scripts"],
    languageIds: ["shellscript"],
    fileExtensions: [".sh", ".bash", ".zsh"],
    fileNames: [".bashrc", ".bash_profile", ".zshrc", ".profile"],
    languageIdByExtension: {},
    builtin: false,
    source: "catalog",
    category: "shell",
  },
  {
    id: "docker-langserver",
    packageName: "dockerfile-language-server-nodejs",
    command: "docker-langserver",
    label: "Dockerfile",
    description: "Build-stage validation and completion for Dockerfiles and container images.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["dockerfile-language-server-nodejs@0.15.0"],
    tags: ["docker", "dockerfile", "container", "devops"],
    languageIds: ["dockerfile"],
    fileExtensions: [],
    fileNames: ["Dockerfile"],
    languageIdByExtension: {},
    builtin: false,
    source: "catalog",
    category: "infra",
  },
  {
    id: "graphql-lsp",
    packageName: "graphql-language-service-cli",
    command: "graphql-lsp",
    label: "GraphQL",
    description: "Autocomplete and validation for standalone GraphQL operations and schema files.",
    installer: "npm",
    args: ["server", "-m", "stream"],
    installPackages: ["graphql-language-service-cli@3.5.0"],
    tags: ["graphql", "gql", "schema", "api"],
    languageIds: ["graphql"],
    fileExtensions: [".graphql", ".gql", ".graphqls"],
    fileNames: [],
    languageIdByExtension: {
      ".gql": "graphql",
      ".graphqls": "graphql",
    },
    builtin: false,
    source: "catalog",
    category: "data",
  },
  {
    id: "basedpyright-langserver",
    packageName: "basedpyright",
    command: "basedpyright-langserver",
    label: "Python (basedpyright)",
    description:
      "Fast Python analysis and type checking with a self-contained uv-installed server.",
    installer: "uv-tool",
    args: ["--stdio"],
    installPackages: ["basedpyright==1.39.3"],
    tags: ["python", "typing", "pyright", "basedpyright"],
    languageIds: ["python"],
    fileExtensions: [".py", ".pyi"],
    fileNames: [],
    languageIdByExtension: {
      ".pyi": "python",
    },
    builtin: false,
    source: "catalog",
    category: "core",
  },
  {
    id: "pylsp",
    packageName: "python-lsp-server",
    command: "pylsp",
    label: "Python (pylsp)",
    description:
      "Plugin-friendly Python language server for completion, symbols, and project-aware analysis.",
    installer: "uv-tool",
    args: [],
    installPackages: ["python-lsp-server==1.14.0"],
    tags: ["python", "pylsp", "jedi", "plugins"],
    languageIds: ["python"],
    fileExtensions: [".py", ".pyi"],
    fileNames: [],
    languageIdByExtension: {
      ".pyi": "python",
    },
    builtin: false,
    source: "catalog",
    category: "core",
  },
  {
    id: "ruff",
    packageName: "ruff",
    command: "ruff",
    label: "Ruff",
    description: "Python linting, fixes, and formatting through Ruff’s built-in language server.",
    installer: "uv-tool",
    args: ["server"],
    installPackages: ["ruff==0.15.11"],
    tags: ["python", "ruff", "lint", "format"],
    languageIds: ["python"],
    fileExtensions: [".py", ".pyi"],
    fileNames: [],
    languageIdByExtension: {
      ".pyi": "python",
    },
    builtin: false,
    source: "catalog",
    category: "core",
  },
  {
    id: "gopls",
    packageName: "golang.org/x/tools/gopls",
    command: "gopls",
    label: "Go",
    description: "The official Go language server maintained by the Go team.",
    installer: "go-install",
    args: [],
    installPackages: ["golang.org/x/tools/gopls@latest"],
    tags: ["go", "golang", "gopls"],
    languageIds: ["go", "gomod", "gowork", "gotmpl"],
    fileExtensions: [".go", ".mod", ".work", ".tmpl"],
    fileNames: ["go.mod", "go.work"],
    languageIdByExtension: {
      ".mod": "gomod",
      ".work": "gowork",
      ".tmpl": "gotmpl",
    },
    builtin: false,
    source: "catalog",
    category: "core",
  },
  {
    id: "rust-analyzer",
    packageName: "rust-analyzer",
    command: "rust-analyzer",
    label: "Rust",
    description: "Official Rust language server installed through rustup components.",
    installer: "rustup",
    args: [],
    installPackages: ["rust-analyzer", "rust-src"],
    tags: ["rust", "rust-analyzer", "cargo"],
    languageIds: ["rust"],
    fileExtensions: [".rs"],
    fileNames: ["Cargo.toml"],
    languageIdByExtension: {},
    builtin: false,
    source: "catalog",
    category: "core",
  },
  {
    id: "prisma-language-server",
    packageName: "@prisma/language-server",
    command: "prisma-language-server",
    label: "Prisma",
    description: "Schema-aware editing for Prisma models, generators, and datasources.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["@prisma/language-server@31.10.0"],
    tags: ["prisma", "schema", "database", "orm"],
    languageIds: ["prisma"],
    fileExtensions: [".prisma"],
    fileNames: [],
    languageIdByExtension: {},
    builtin: false,
    source: "catalog",
    category: "data",
  },
  {
    id: "vue-language-server",
    packageName: "@vue/language-server",
    command: "vue-language-server",
    label: "Vue",
    description: "Language intelligence for single-file Vue components powered by Volar.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["@vue/language-server@3.2.7"],
    tags: ["vue", "volar", "sfc", "frontend"],
    languageIds: ["vue"],
    fileExtensions: [".vue"],
    fileNames: [],
    languageIdByExtension: {},
    builtin: false,
    source: "catalog",
    category: "framework",
  },
  {
    id: "svelte-language-server",
    packageName: "svelte-language-server",
    command: "svelteserver",
    label: "Svelte",
    description: "Diagnostics and completion for Svelte and SvelteKit component files.",
    installer: "npm",
    args: ["--stdio"],
    installPackages: ["svelte-language-server@0.17.30"],
    tags: ["svelte", "sveltekit", "frontend"],
    languageIds: ["svelte"],
    fileExtensions: [".svelte"],
    fileNames: [],
    languageIdByExtension: {},
    builtin: false,
    source: "catalog",
    category: "framework",
  },
] as const;

const LSP_REGISTRY_FILENAME = "registry.json";

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeFileName(value: string): string {
  return basename(value.trim()).toLowerCase();
}

function normalizeLanguageId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  return Array.from(
    new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0)),
  );
}

function normalizeServerArgs(args: readonly string[] | undefined): readonly string[] {
  if (!args) {
    return ["--stdio"];
  }
  const next = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  return next.length > 0 ? next : ["--stdio"];
}

function normalizeInstallPackages(
  packageName: string,
  installPackages: readonly string[] | undefined,
): readonly string[] {
  const normalized = Array.from(
    new Set(
      (installPackages ?? [packageName])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
  return normalized.length > 0 ? normalized : [packageName];
}

function normalizeInstaller(value: ServerLspToolInstaller | undefined): LspToolInstaller {
  switch (value) {
    case "uv-tool":
    case "go-install":
    case "rustup":
      return value;
    default:
      return "npm";
  }
}

function parsePinnedVersionFromSpecifier(
  installer: LspToolInstaller,
  packageName: string,
  specifier: string,
): string | null {
  const trimmed = specifier.trim();
  if (installer === "uv-tool") {
    const [name, version] = trimmed.split("==", 2);
    return name === packageName && version && version.length > 0 ? version : null;
  }
  const prefix = `${packageName}@`;
  return trimmed.startsWith(prefix) && trimmed.length > prefix.length
    ? trimmed.slice(prefix.length)
    : null;
}

function getLspToolSearchText(tool: LspToolDefinition): string {
  return [
    tool.label,
    tool.description,
    tool.packageName,
    tool.command,
    ...tool.tags,
    ...tool.languageIds,
    ...tool.fileExtensions,
    ...tool.fileNames,
  ]
    .join(" ")
    .toLowerCase();
}

function normalizeLanguageIdByExtension(
  languageIds: readonly string[],
  mapping: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const allowedIds = new Set(languageIds);
  const entries = Object.entries(mapping ?? {}).flatMap(([rawExtension, rawLanguageId]) => {
    const extension = normalizeExtension(rawExtension);
    const languageId = normalizeLanguageId(rawLanguageId);
    if (
      extension.length <= 1 ||
      !allowedIds.has(languageId) ||
      extname(`index${extension}`) !== extension
    ) {
      return [];
    }
    return [[extension, languageId] as const];
  });
  return Object.fromEntries(entries);
}

function normalizeDefinition(
  definition: Omit<LspToolDefinition, "builtin" | "source" | "category" | "installer"> & {
    readonly installer?: LspToolInstaller;
    readonly builtin?: boolean;
    readonly source?: LspToolSource;
    readonly category?: LspToolCategory;
  },
): LspToolDefinition | null {
  const id = definition.id.trim();
  const packageName = definition.packageName.trim();
  const command = definition.command.trim();
  const label = definition.label.trim();
  const description = definition.description.trim();
  if (
    id.length === 0 ||
    packageName.length === 0 ||
    command.length === 0 ||
    label.length === 0 ||
    description.length === 0
  ) {
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
  const fileNames = Array.from(
    new Set(
      definition.fileNames
        .map(normalizeFileName)
        .filter((value) => value.length > 0 && !value.includes("/") && !value.includes("\\")),
    ),
  );
  if (languageIds.length === 0 || (fileExtensions.length === 0 && fileNames.length === 0)) {
    return null;
  }

  return {
    id,
    packageName,
    command,
    label,
    description,
    installer: normalizeInstaller(definition.installer),
    args: normalizeServerArgs(definition.args),
    installPackages: normalizeInstallPackages(packageName, definition.installPackages),
    tags: normalizeTags(definition.tags),
    languageIds,
    fileExtensions,
    fileNames,
    languageIdByExtension: normalizeLanguageIdByExtension(
      languageIds,
      definition.languageIdByExtension,
    ),
    builtin: definition.builtin ?? false,
    source: definition.source ?? (definition.builtin ? "builtin" : "custom"),
    category: definition.category ?? (definition.builtin ? "core" : "custom"),
    ...(definition.envBinKey?.trim() ? { envBinKey: definition.envBinKey.trim() } : {}),
    ...(definition.envArgsJsonKey?.trim()
      ? { envArgsJsonKey: definition.envArgsJsonKey.trim() }
      : {}),
  };
}

function toRuntimeServerDefinition(
  definition: LspToolDefinition,
  resolvedCommand: string,
): RuntimeLspServerDefinition {
  return {
    id: definition.id,
    packageName: definition.packageName,
    command: resolvedCommand,
    installer: definition.installer,
    args: definition.args,
    languageIds: new Set(definition.languageIds),
    fileExtensions: new Set(definition.fileExtensions),
    fileNames: new Set(definition.fileNames),
    languageIdByExtension: new Map(Object.entries(definition.languageIdByExtension)),
    builtin: definition.builtin,
    source: definition.source,
    ...(definition.envBinKey ? { envBinKey: definition.envBinKey } : {}),
    ...(definition.envArgsJsonKey ? { envArgsJsonKey: definition.envArgsJsonKey } : {}),
  };
}

function resolveInstallDir(stateDir: string): string {
  return join(stateDir, "lsp-tools");
}

function resolveNpmInstallDir(stateDir: string): string {
  return resolveInstallDir(stateDir);
}

function resolveNpmBinDir(stateDir: string): string {
  return join(resolveNpmInstallDir(stateDir), "node_modules", ".bin");
}

function resolveUvInstallDir(stateDir: string): string {
  return join(resolveInstallDir(stateDir), "uv");
}

function resolveUvDataHome(stateDir: string): string {
  return join(resolveUvInstallDir(stateDir), "data");
}

function resolveUvBinDir(stateDir: string): string {
  return join(resolveUvInstallDir(stateDir), "bin");
}

function resolveGoInstallDir(stateDir: string): string {
  return join(resolveInstallDir(stateDir), "go");
}

function resolveGoBinDir(stateDir: string): string {
  return join(resolveGoInstallDir(stateDir), "bin");
}

function resolveCargoBinDir(): string {
  return join(homedir(), ".cargo", "bin");
}

async function resolveRustupBinaryPath(command: string): Promise<string | null> {
  if (!isCommandAvailable("rustup")) {
    return null;
  }
  const result = await runProcess("rustup", ["which", command], {
    timeoutMs: 30_000,
    maxBufferBytes: 256 * 1024,
    outputMode: "truncate",
    allowNonZeroExit: true,
  });
  const resolved = result.stdout.trim();
  if (resolved.length === 0) {
    return null;
  }
  return (await isPathExecutable(resolved)) ? resolved : null;
}

function resolveBinaryCandidatePaths(
  stateDir: string,
  tool: Pick<LspToolDefinition, "installer" | "command">,
): readonly string[] {
  const suffixes =
    process.platform === "win32"
      ? tool.installer === "npm"
        ? [".cmd", ".exe", ""]
        : [".exe", ".cmd", ""]
      : [""];
  const binDir =
    tool.installer === "uv-tool"
      ? resolveUvBinDir(stateDir)
      : tool.installer === "go-install"
        ? resolveGoBinDir(stateDir)
        : tool.installer === "rustup"
          ? resolveCargoBinDir()
          : resolveNpmBinDir(stateDir);
  return suffixes.map((suffix) => join(binDir, `${tool.command}${suffix}`));
}

async function resolveInstalledBinaryPath(
  stateDir: string,
  tool: Pick<LspToolDefinition, "installer" | "command">,
): Promise<string | null> {
  if (tool.installer === "rustup") {
    return resolveRustupBinaryPath(tool.command);
  }
  for (const candidate of resolveBinaryCandidatePaths(stateDir, tool)) {
    if (await isPathExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function formatToolProbeLabel(tool: Pick<LspToolDefinition, "id" | "command">): string {
  return tool.id.trim().length > 0 ? tool.id : tool.command;
}

async function safeResolveInstalledBinaryPath(
  stateDir: string,
  tool: Pick<LspToolDefinition, "id" | "installer" | "command">,
): Promise<string | null> {
  try {
    return await resolveInstalledBinaryPath(stateDir, tool);
  } catch (error) {
    console.warn(
      `Failed to resolve installed language server binary for ${formatToolProbeLabel(tool)}.`,
      error,
    );
    return null;
  }
}

async function readToolVersion(
  stateDir: string,
  tool: Pick<LspToolDefinition, "installer" | "packageName" | "installPackages">,
): Promise<string | null> {
  if (tool.installer === "npm") {
    const installedVersion = await readInstalledPackageVersion(
      resolveNpmInstallDir(stateDir),
      tool.packageName,
    );
    if (installedVersion) {
      return installedVersion;
    }
  } else {
    for (const specifier of tool.installPackages) {
      const version = parsePinnedVersionFromSpecifier(tool.installer, tool.packageName, specifier);
      if (version) {
        return version;
      }
    }
  }
  for (const specifier of tool.installPackages) {
    const version = parsePinnedVersionFromSpecifier(tool.installer, tool.packageName, specifier);
    if (version) {
      return version;
    }
  }
  return null;
}

async function safeReadToolVersion(
  stateDir: string,
  tool: Pick<LspToolDefinition, "id" | "command" | "installer" | "packageName" | "installPackages">,
): Promise<string | null> {
  try {
    return await readToolVersion(stateDir, tool);
  } catch (error) {
    console.warn(
      `Failed to read language server version for ${formatToolProbeLabel(tool)}.`,
      error,
    );
    return null;
  }
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
    const parsed = JSON.parse(raw) as
      | SerializedLspRegistry
      | { version?: unknown; tools?: unknown };
    if (
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
      !Array.isArray(parsed.tools)
    ) {
      return [];
    }
    return parsed.tools
      .map((tool) =>
        normalizeDefinition({
          id: tool.id,
          packageName: tool.packageName,
          command: tool.command,
          label: tool.label,
          installer: tool.installer ?? "npm",
          description:
            typeof tool.description === "string" && tool.description.trim().length > 0
              ? tool.description
              : `${tool.label} custom language server.`,
          args: tool.args,
          installPackages: tool.installPackages,
          tags: [],
          languageIds: tool.languageIds,
          fileExtensions: tool.fileExtensions,
          fileNames: tool.fileNames ?? [],
          languageIdByExtension: {},
          builtin: false,
          source: "custom",
          category: "custom",
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
    version: 3,
    tools: tools
      .filter((tool) => tool.source === "custom")
      .map((tool) => ({
        id: tool.id,
        packageName: tool.packageName,
        command: tool.command,
        label: tool.label,
        installer: tool.installer,
        description: tool.description,
        args: tool.args,
        installPackages: tool.installPackages,
        languageIds: tool.languageIds,
        fileExtensions: tool.fileExtensions,
        fileNames: tool.fileNames,
      })),
  };
  await writeFile(resolveRegistryPath(stateDir), JSON.stringify(payload, null, 2), "utf8");
}

export async function getLspToolDefinitions(
  stateDir: string,
): Promise<readonly LspToolDefinition[]> {
  const customTools = await readCustomRegistry(stateDir);
  const byId = new Map<string, LspToolDefinition>();
  for (const builtin of CORE_LSP_TOOL_DEFINITIONS) {
    byId.set(builtin.id, builtin);
  }
  for (const catalogTool of CURATED_LSP_TOOL_DEFINITIONS) {
    byId.set(catalogTool.id, catalogTool);
  }
  for (const custom of customTools) {
    byId.set(custom.id, custom);
  }
  return [...byId.values()];
}

export async function searchLspMarketplace(
  query: string,
  limit: number,
): Promise<ServerLspMarketplaceSearchResult> {
  const normalizedQuery = query.trim().toLowerCase();
  const searchLimit = Math.max(1, Math.min(limit, 50));
  const definitions = [...CORE_LSP_TOOL_DEFINITIONS, ...CURATED_LSP_TOOL_DEFINITIONS];
  const packages = definitions
    .filter((tool) => {
      if (normalizedQuery.length === 0) {
        return true;
      }
      return getLspToolSearchText(tool).includes(normalizedQuery);
    })
    .slice(0, searchLimit)
    .map((tool) => ({
      packageName: tool.packageName,
      description: tool.description,
      version: null,
      keywords: [...tool.tags],
    }));
  return {
    query: query.trim(),
    packages,
  };
}

export async function getLspServerRegistry(
  stateDir: string,
): Promise<readonly RuntimeLspServerDefinition[]> {
  const tools = await getLspToolDefinitions(stateDir);
  return Promise.all(
    tools.map(async (tool) => {
      const resolvedCommand =
        (await safeResolveInstalledBinaryPath(stateDir, tool)) ?? tool.command;
      return toRuntimeServerDefinition(tool, resolvedCommand);
    }),
  );
}

export async function getLspToolsStatus(stateDir: string): Promise<ServerLspToolsStatus> {
  const installDir = resolveInstallDir(stateDir);
  const definitions = await getLspToolDefinitions(stateDir);

  const tools: ServerLspToolStatus[] = await Promise.all(
    definitions.map(async (tool) => {
      const binaryPath = await safeResolveInstalledBinaryPath(stateDir, tool);
      const installed = binaryPath !== null;
      const version = installed ? await safeReadToolVersion(stateDir, tool) : null;
      return {
        id: tool.id,
        label: tool.label,
        description: tool.description,
        source: tool.source,
        category: tool.category,
        installer: tool.installer,
        command: tool.command,
        args: [...tool.args],
        packageName: tool.packageName,
        installPackages: [...tool.installPackages],
        tags: [...tool.tags],
        languageIds: [...tool.languageIds],
        fileExtensions: [...tool.fileExtensions],
        fileNames: [...tool.fileNames],
        builtin: tool.builtin,
        installed,
        version,
        binaryPath,
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
  const installDir = resolveNpmInstallDir(stateDir);
  if (options.reinstall) {
    await Promise.all([
      rm(join(installDir, "node_modules"), { recursive: true, force: true }),
      rm(join(installDir, "package-lock.json"), { force: true }),
      rm(join(installDir, "package.json"), { force: true }),
    ]);
  }
  await installRuntimePackagesWithNpm({
    installDir,
    packageJsonName: "ace-lsp-tools",
    packages,
  });
}

async function installPackagesWithInstaller(
  stateDir: string,
  installer: LspToolInstaller,
  packages: readonly string[],
  options: { readonly reinstall?: boolean } = {},
): Promise<void> {
  if (installer === "uv-tool") {
    if (!isCommandAvailable("uv")) {
      throw new Error("Cannot install language servers because uv is not available in PATH.");
    }
    const [packageSpec, ...withPackages] = packages;
    if (!packageSpec) {
      return;
    }
    await installPackagesWithUvTool({
      dataHome: resolveUvDataHome(stateDir),
      binHome: resolveUvBinDir(stateDir),
      packageSpec,
      withPackages,
      ...(options.reinstall !== undefined ? { reinstall: options.reinstall } : {}),
    });
    return;
  }

  if (installer === "go-install") {
    if (!isCommandAvailable("go")) {
      throw new Error("Cannot install language servers because Go is not available in PATH.");
    }
    await installPackagesWithGoInstall({
      binDir: resolveGoBinDir(stateDir),
      packages,
    });
    return;
  }

  if (installer === "rustup") {
    if (!isCommandAvailable("rustup")) {
      throw new Error("Cannot install language servers because rustup is not available in PATH.");
    }
    if (packages.length === 0) {
      return;
    }
    await runProcess("rustup", ["component", "add", ...packages], {
      timeoutMs: 240_000,
      maxBufferBytes: 2 * 1024 * 1024,
      outputMode: "truncate",
    });
    return;
  }

  if (!isCommandAvailable("npm")) {
    throw new Error("Cannot install language servers because npm is not available in PATH.");
  }
  await installPackagesWithNpm(stateDir, packages, options);
}

export async function installLspTools(
  stateDir: string,
  options: { readonly reinstall?: boolean } = {},
): Promise<ServerLspToolsStatus> {
  if (!isCommandAvailable("npm")) {
    throw new Error("Cannot install language servers because npm is not available in PATH.");
  }
  const packages = Array.from(
    new Set(CORE_LSP_TOOL_DEFINITIONS.flatMap((tool) => tool.installPackages)),
  );
  await installPackagesWithNpm(stateDir, packages, options);
  return getLspToolsStatus(stateDir);
}

export async function installLspTool(
  stateDir: string,
  input: ServerInstallLspToolInput,
): Promise<ServerLspToolsStatus> {
  const packageName = input.packageName.trim();
  const command = input.command.trim();
  const label = input.label.trim();
  const installer = normalizeInstaller(input.installer);
  const description = input.description?.trim() || `${label} custom language server.`;
  const languageIds = Array.from(
    new Set(input.languageIds.map(normalizeLanguageId).filter((value) => value.length > 0)),
  );
  const fileExtensions = Array.from(
    new Set(
      input.fileExtensions
        .map(normalizeExtension)
        .filter((value) => value.length > 1 && extname(`index${value}`) === value),
    ),
  );
  const fileNames = Array.from(
    new Set((input.fileNames ?? []).map(normalizeFileName).filter((value) => value.length > 0)),
  );
  if (packageName.length === 0 || command.length === 0 || label.length === 0) {
    throw new Error("Package name, command, and label are required to install a language server.");
  }
  if (languageIds.length === 0 || (fileExtensions.length === 0 && fileNames.length === 0)) {
    throw new Error("At least one language id and one file extension or file name are required.");
  }

  const installOptions = input.reinstall === undefined ? {} : { reinstall: input.reinstall };
  const installPackages = normalizeInstallPackages(packageName, input.installPackages);
  await installPackagesWithInstaller(stateDir, installer, installPackages, installOptions);

  const existingTools = await getLspToolDefinitions(stateDir);
  const id = command;
  const existingDefinition = existingTools.find((tool) => tool.id === id);
  if (
    existingDefinition &&
    existingDefinition.source !== "custom" &&
    existingDefinition.installer === installer &&
    existingDefinition.packageName === packageName &&
    existingDefinition.command === command
  ) {
    return getLspToolsStatus(stateDir);
  }
  const customTools = existingTools.filter((tool) => tool.source === "custom" && tool.id !== id);
  const normalized = normalizeDefinition({
    id,
    packageName,
    command,
    label,
    installer,
    description,
    args: normalizeServerArgs(input.args),
    installPackages,
    tags: [],
    languageIds,
    fileExtensions,
    fileNames,
    languageIdByExtension: {},
    builtin: false,
    source: "custom",
    category: "custom",
  });
  if (!normalized) {
    throw new Error("Unable to register the language server due to invalid metadata.");
  }
  await writeCustomRegistry(stateDir, [...customTools, normalized]);
  return getLspToolsStatus(stateDir);
}
