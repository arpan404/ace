import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { ServerLspToolStatus, ServerLspToolsStatus } from "@ace/contracts";

import { isCommandAvailable } from "./open";
import { runProcess } from "./processRunner";

interface LspToolDefinition {
  readonly id: ServerLspToolStatus["id"];
  readonly packageName: string;
  readonly command: string;
  readonly label: string;
}

const LSP_TOOL_DEFINITIONS: readonly LspToolDefinition[] = [
  {
    id: "typescript-language-server",
    packageName: "typescript-language-server",
    command: "typescript-language-server",
    label: "TypeScript / JavaScript",
  },
  {
    id: "vscode-json-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-json-language-server",
    label: "JSON",
  },
  {
    id: "vscode-css-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-css-language-server",
    label: "CSS",
  },
  {
    id: "vscode-html-language-server",
    packageName: "vscode-langservers-extracted",
    command: "vscode-html-language-server",
    label: "HTML",
  },
];

const LSP_PACKAGE_VERSION_BY_NAME = {
  typescript: "^5.9.2",
  "typescript-language-server": "^5.0.1",
  "vscode-langservers-extracted": "^4.10.0",
} as const;

function resolveInstallDir(stateDir: string): string {
  return join(stateDir, "lsp-tools");
}

function resolveBinDir(stateDir: string): string {
  return join(resolveInstallDir(stateDir), "node_modules", ".bin");
}

function normalizePathVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function createInstallEnvironment(stateDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const binDir = resolveBinDir(stateDir);
  const currentPath = normalizePathVariable(env);
  env.PATH = [binDir, ...currentPath.split(delimiter).filter(Boolean)].join(delimiter);
  return env;
}

async function isPathExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersion(installDir: string, packageName: string): Promise<string | null> {
  const packageJsonPath = join(installDir, "node_modules", packageName, "package.json");
  try {
    const rawPackageJson = await readFile(packageJsonPath, "utf8");
    const decoded = JSON.parse(rawPackageJson) as { version?: unknown };
    return typeof decoded.version === "string" && decoded.version.length > 0
      ? decoded.version
      : null;
  } catch {
    return null;
  }
}

export async function getLspToolsStatus(stateDir: string): Promise<ServerLspToolsStatus> {
  const installDir = resolveInstallDir(stateDir);
  const commandSuffix = process.platform === "win32" ? ".cmd" : "";

  const tools: ServerLspToolStatus[] = await Promise.all(
    LSP_TOOL_DEFINITIONS.map(async (tool) => {
      const binaryPath = join(resolveBinDir(stateDir), `${tool.command}${commandSuffix}`);
      const installed = await isPathExecutable(binaryPath);
      const version = await readPackageVersion(installDir, tool.packageName);
      return {
        id: tool.id,
        label: tool.label,
        command: tool.command,
        packageName: tool.packageName,
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

async function ensureInstallRoot(installDir: string): Promise<void> {
  await mkdir(installDir, { recursive: true });
  const packageJsonPath = join(installDir, "package.json");
  const packageJson = {
    name: "ace-lsp-tools",
    private: true,
  };
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf8");
}

async function installWithNpm(stateDir: string): Promise<void> {
  const installDir = resolveInstallDir(stateDir);
  await ensureInstallRoot(installDir);
  const packageArguments = Object.entries(LSP_PACKAGE_VERSION_BY_NAME).map(
    ([name, version]) => `${name}@${version}`,
  );
  await runProcess(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--prefix",
      installDir,
      ...packageArguments,
    ],
    {
      timeoutMs: 240_000,
      env: createInstallEnvironment(stateDir),
      maxBufferBytes: 2 * 1024 * 1024,
      outputMode: "truncate",
    },
  );
}

export async function installLspTools(
  stateDir: string,
  options: { readonly reinstall?: boolean } = {},
): Promise<ServerLspToolsStatus> {
  const installDir = resolveInstallDir(stateDir);
  if (options.reinstall) {
    await rm(installDir, { recursive: true, force: true });
  }

  if (!isCommandAvailable("npm")) {
    throw new Error("Cannot install language servers because npm is not available in PATH.");
  }
  await installWithNpm(stateDir);
  return getLspToolsStatus(stateDir);
}
