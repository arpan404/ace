import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { resolveLoginShell } from "./shell";

const MANAGED_PATH_BLOCK_START = "# >>> ace cli >>>";
const MANAGED_PATH_BLOCK_END = "# <<< ace cli <<<";
const WINDOWS_USER_PATH_TARGET = "User PATH";

export interface AceCliInstallTarget {
  readonly launchCommand: string;
  readonly cliEntry: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface AceCliInstallOptions {
  readonly target: AceCliInstallTarget;
  readonly baseDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly shell?: string;
  readonly readWindowsUserPath?: () => string | undefined;
  readonly writeWindowsUserPath?: (value: string) => void;
}

export interface AceCliInstallStatus {
  readonly binDir: string;
  readonly commandPath: string;
  readonly shimInstalled: boolean;
  readonly launchCommand: string;
  readonly launchCommandExists: boolean;
  readonly cliEntry: string;
  readonly cliEntryExists: boolean;
  readonly pathInCurrentProcess: boolean;
  readonly pathPersisted: boolean;
  readonly pathTargets: ReadonlyArray<string>;
  readonly shell: string | undefined;
  readonly ready: boolean;
}

export interface AceCliInstallResult extends AceCliInstallStatus {
  readonly changed: boolean;
  readonly pathChanged: boolean;
  readonly restartRequired: boolean;
}

function resolvePathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function setPathValue(env: NodeJS.ProcessEnv, value: string): void {
  env.PATH = value;
  if ("Path" in env) {
    env.Path = value;
  }
  if ("path" in env) {
    env.path = value;
  }
}

function normalizePathForComparison(pathValue: string, platform: NodeJS.Platform): string {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const normalized = Path.normalize(trimmed).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function splitPathValue(pathValue: string, platform: NodeJS.Platform): ReadonlyArray<string> {
  const delimiter = platform === "win32" ? ";" : ":";
  return pathValue
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
    .filter((entry) => entry.length > 0);
}

function prependPathEntry(pathValue: string, entry: string, platform: NodeJS.Platform): string {
  if (pathHasEntry(pathValue, entry, platform)) {
    return pathValue;
  }

  const delimiter = platform === "win32" ? ";" : ":";
  return pathValue.length > 0 ? `${entry}${delimiter}${pathValue}` : entry;
}

function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteWindowsCmdArgument(value: string): string {
  return value.replace(/"/g, '""');
}

function resolveShellKind(shell: string | undefined): "bash" | "fish" | "zsh" | "posix" {
  const shellName = shell ? Path.basename(shell).toLowerCase() : "";
  if (shellName.includes("fish")) {
    return "fish";
  }
  if (shellName.includes("zsh")) {
    return "zsh";
  }
  if (shellName.includes("bash")) {
    return "bash";
  }
  return "posix";
}

function buildManagedPathBlock(binDir: string, shell: "bash" | "fish" | "zsh" | "posix"): string {
  if (shell === "fish") {
    return [
      MANAGED_PATH_BLOCK_START,
      `set -gx ACE_CLI_BIN_DIR ${quotePosixShell(binDir)}`,
      'if not contains -- "$ACE_CLI_BIN_DIR" $PATH',
      '  set -gx PATH "$ACE_CLI_BIN_DIR" $PATH',
      "end",
      MANAGED_PATH_BLOCK_END,
      "",
    ].join("\n");
  }

  return [
    MANAGED_PATH_BLOCK_START,
    `ACE_CLI_BIN_DIR=${quotePosixShell(binDir)}`,
    'case ":$PATH:" in',
    '  *":$ACE_CLI_BIN_DIR:"*) ;;',
    '  *) export PATH="$ACE_CLI_BIN_DIR:$PATH" ;;',
    "esac",
    MANAGED_PATH_BLOCK_END,
    "",
  ].join("\n");
}

function buildPosixLauncherScript(target: AceCliInstallTarget): string {
  const environment = Object.entries(target.environment ?? {}).map(
    ([name, value]) => `export ${name}=${quotePosixShell(value)}`,
  );

  return [
    "#!/bin/sh",
    "set -eu",
    ...environment,
    `exec ${quotePosixShell(target.launchCommand)} ${quotePosixShell(target.cliEntry)} "$@"`,
    "",
  ].join("\n");
}

function buildWindowsLauncherScript(target: AceCliInstallTarget): string {
  const environment = Object.entries(target.environment ?? {}).map(
    ([name, value]) => `set "${name}=${quoteWindowsCmdArgument(value)}"`,
  );

  return [
    "@echo off",
    "setlocal",
    ...environment,
    `"${quoteWindowsCmdArgument(target.launchCommand)}" "${quoteWindowsCmdArgument(target.cliEntry)}" %*`,
    "",
  ].join("\r\n");
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return FS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function hasManagedPathBlock(filePath: string): boolean {
  const content = readFileIfExists(filePath);
  return (
    content?.includes(MANAGED_PATH_BLOCK_START) === true && content.includes(MANAGED_PATH_BLOCK_END)
  );
}

function fileIncludesPathReference(filePath: string, binDir: string): boolean {
  const content = readFileIfExists(filePath);
  return content?.includes(binDir) === true;
}

function upsertManagedPathBlock(existingContent: string | undefined, block: string): string {
  const existing = existingContent ?? "";
  const startIndex = existing.indexOf(MANAGED_PATH_BLOCK_START);
  const endIndex = startIndex === -1 ? -1 : existing.indexOf(MANAGED_PATH_BLOCK_END, startIndex);
  const normalizedBlock = block.trimEnd();

  if (startIndex !== -1 && endIndex !== -1) {
    const afterIndex = endIndex + MANAGED_PATH_BLOCK_END.length;
    const before = existing.slice(0, startIndex).trimEnd();
    const after = existing.slice(afterIndex).trimStart();
    if (before.length > 0 && after.length > 0) {
      return `${before}\n\n${normalizedBlock}\n\n${after}\n`;
    }
    if (before.length > 0) {
      return `${before}\n\n${normalizedBlock}\n`;
    }
    if (after.length > 0) {
      return `${normalizedBlock}\n\n${after}\n`;
    }
    return `${normalizedBlock}\n`;
  }

  const trimmed = existing.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${normalizedBlock}\n` : `${normalizedBlock}\n`;
}

function writeFileIfChanged(filePath: string, content: string, mode?: number): boolean {
  const existing = readFileIfExists(filePath);
  if (existing !== content) {
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, content, "utf8");
  }

  if (mode !== undefined && FS.existsSync(filePath)) {
    FS.chmodSync(filePath, mode);
  }

  return existing !== content;
}

function runPowerShell(command: string): string {
  const candidates = ["powershell", "pwsh"];
  let lastError: unknown = undefined;

  for (const candidate of candidates) {
    try {
      return execFileSync(
        candidate,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        },
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("PowerShell is not available.");
}

function defaultReadWindowsUserPath(): string | undefined {
  try {
    const value = runPowerShell("[Environment]::GetEnvironmentVariable('Path', 'User')");
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function defaultWriteWindowsUserPath(value: string): void {
  runPowerShell(`[Environment]::SetEnvironmentVariable('Path', ${quotePowerShell(value)}, 'User')`);
}

function resolveUnixPathTargets(options: {
  readonly homeDir: string;
  readonly shell: string | undefined;
}): ReadonlyArray<string> {
  const shell = resolveShellKind(options.shell);
  switch (shell) {
    case "fish":
      return [Path.join(options.homeDir, ".config", "fish", "config.fish")];
    case "zsh":
      return [Path.join(options.homeDir, ".zprofile"), Path.join(options.homeDir, ".zshrc")];
    case "bash":
      return [Path.join(options.homeDir, ".bash_profile"), Path.join(options.homeDir, ".bashrc")];
    default:
      return [Path.join(options.homeDir, ".profile")];
  }
}

export function resolveAceCliBinDir(
  options: {
    readonly baseDir?: string;
    readonly homeDir?: string;
  } = {},
): string {
  const baseDir = options.baseDir?.trim();
  if (baseDir && baseDir.length > 0) {
    return Path.join(baseDir, "bin");
  }

  return Path.join(options.homeDir ?? OS.homedir(), ".ace", "bin");
}

export function resolveAceCliCommandPath(
  binDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return Path.join(binDir, platform === "win32" ? "ace.cmd" : "ace");
}

export function pathHasEntry(
  pathValue: string,
  entry: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedEntry = normalizePathForComparison(entry, platform);
  if (normalizedEntry.length === 0) {
    return false;
  }

  return splitPathValue(pathValue, platform).some(
    (candidate) => normalizePathForComparison(candidate, platform) === normalizedEntry,
  );
}

export function resolveAceCliPathTargets(
  options: Omit<AceCliInstallOptions, "target">,
): ReadonlyArray<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    return [WINDOWS_USER_PATH_TARGET];
  }

  const homeDir = options.homeDir ?? OS.homedir();
  const shell = options.shell ?? resolveLoginShell(platform, env.SHELL);
  return resolveUnixPathTargets({ homeDir, shell });
}

export function inspectAceCliInstall(options: AceCliInstallOptions): AceCliInstallStatus {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const binDir = resolveAceCliBinDir({
    ...(options.baseDir !== undefined ? { baseDir: options.baseDir } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
  const commandPath = resolveAceCliCommandPath(binDir, platform);
  const shell = options.shell ?? resolveLoginShell(platform, env.SHELL);
  const pathTargets = resolveAceCliPathTargets({
    platform,
    env,
    ...(options.baseDir !== undefined ? { baseDir: options.baseDir } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(shell !== undefined ? { shell } : {}),
    ...(options.readWindowsUserPath !== undefined
      ? { readWindowsUserPath: options.readWindowsUserPath }
      : {}),
    ...(options.writeWindowsUserPath !== undefined
      ? { writeWindowsUserPath: options.writeWindowsUserPath }
      : {}),
  });
  const pathInCurrentProcess = pathHasEntry(resolvePathValue(env), binDir, platform);
  const pathPersisted =
    platform === "win32"
      ? pathHasEntry(
          (options.readWindowsUserPath ?? defaultReadWindowsUserPath)() ?? "",
          binDir,
          platform,
        )
      : pathTargets.some(
          (target) => hasManagedPathBlock(target) || fileIncludesPathReference(target, binDir),
        );
  const shimInstalled = FS.existsSync(commandPath);
  const launchCommandExists = FS.existsSync(options.target.launchCommand);
  const cliEntryExists = FS.existsSync(options.target.cliEntry);

  return {
    binDir,
    commandPath,
    shimInstalled,
    launchCommand: options.target.launchCommand,
    launchCommandExists,
    cliEntry: options.target.cliEntry,
    cliEntryExists,
    pathInCurrentProcess,
    pathPersisted,
    pathTargets,
    shell,
    ready:
      shimInstalled &&
      launchCommandExists &&
      cliEntryExists &&
      (pathInCurrentProcess || pathPersisted),
  };
}

export function ensureAceCliInstalled(options: AceCliInstallOptions): AceCliInstallResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const before = inspectAceCliInstall(options);

  const launcherContent =
    platform === "win32"
      ? buildWindowsLauncherScript(options.target)
      : buildPosixLauncherScript(options.target);
  const shimChanged = writeFileIfChanged(
    before.commandPath,
    launcherContent,
    platform === "win32" ? undefined : 0o755,
  );

  let pathChanged = false;

  if (platform === "win32") {
    const readUserPath = options.readWindowsUserPath ?? defaultReadWindowsUserPath;
    const writeUserPath = options.writeWindowsUserPath ?? defaultWriteWindowsUserPath;
    const userPath = readUserPath() ?? "";
    if (!pathHasEntry(userPath, before.binDir, platform)) {
      writeUserPath(prependPathEntry(userPath, before.binDir, platform));
      pathChanged = true;
    }
  } else if (!before.pathPersisted) {
    const block = buildManagedPathBlock(before.binDir, resolveShellKind(before.shell));
    for (const target of before.pathTargets) {
      const nextContent = upsertManagedPathBlock(readFileIfExists(target), block);
      if (writeFileIfChanged(target, nextContent)) {
        pathChanged = true;
      }
    }
  }

  if (!pathHasEntry(resolvePathValue(env), before.binDir, platform)) {
    setPathValue(env, prependPathEntry(resolvePathValue(env), before.binDir, platform));
  }

  const after = inspectAceCliInstall(options);
  return {
    ...after,
    changed: shimChanged || pathChanged,
    pathChanged,
    restartRequired: pathChanged,
  };
}
