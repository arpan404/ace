import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { isCommandAvailable } from "./open";
import { runProcess } from "./processRunner";

function normalizePathVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function createInstallEnvironment(installDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const binDir = join(installDir, "node_modules", ".bin");
  const currentPath = normalizePathVariable(env);
  env.PATH = [binDir, ...currentPath.split(delimiter).filter(Boolean)].join(delimiter);
  return env;
}

function createUvToolEnvironment(input: {
  readonly dataHome: string;
  readonly binHome: string;
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const currentPath = normalizePathVariable(env);
  env.XDG_DATA_HOME = input.dataHome;
  env.XDG_BIN_HOME = input.binHome;
  env.PATH = [input.binHome, ...currentPath.split(delimiter).filter(Boolean)].join(delimiter);
  return env;
}

function createGoInstallEnvironment(input: { readonly binDir: string }): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const currentPath = normalizePathVariable(env);
  env.GOBIN = input.binDir;
  env.PATH = [input.binDir, ...currentPath.split(delimiter).filter(Boolean)].join(delimiter);
  return env;
}

export function assertNpmAvailable(message: string): void {
  if (!isCommandAvailable("npm")) {
    throw new Error(message);
  }
}

export async function ensurePackageInstallRoot(
  installDir: string,
  packageJsonName = "ace-runtime-packages",
): Promise<void> {
  await mkdir(installDir, { recursive: true });
  const packageJsonPath = join(installDir, "package.json");
  try {
    await readFile(packageJsonPath, "utf8");
    return;
  } catch {
    // Fall through and create a fresh manifest.
  }
  const packageJson = {
    name: packageJsonName,
    private: true,
  };
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf8");
}

export async function readInstalledPackageVersion(
  installDir: string,
  packageName: string,
): Promise<string | null> {
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

export async function installPackagesWithNpm(input: {
  readonly installDir: string;
  readonly packageJsonName?: string;
  readonly packages: readonly string[];
  readonly reinstall?: boolean;
  readonly timeoutMs?: number;
}): Promise<void> {
  const { installDir, packageJsonName, packages, reinstall = false, timeoutMs = 240_000 } = input;
  if (reinstall) {
    await rm(installDir, { recursive: true, force: true });
  }
  await ensurePackageInstallRoot(installDir, packageJsonName);
  if (packages.length === 0) {
    return;
  }
  await runProcess(
    "npm",
    ["install", "--no-audit", "--no-fund", "--save-exact", "--prefix", installDir, ...packages],
    {
      timeoutMs,
      env: createInstallEnvironment(installDir),
      maxBufferBytes: 2 * 1024 * 1024,
      outputMode: "truncate",
    },
  );
}

export async function installPackagesWithUvTool(input: {
  readonly dataHome: string;
  readonly binHome: string;
  readonly packageSpec: string;
  readonly withPackages?: readonly string[];
  readonly reinstall?: boolean;
  readonly python?: string;
  readonly timeoutMs?: number;
}): Promise<void> {
  const {
    dataHome,
    binHome,
    packageSpec,
    withPackages = [],
    reinstall = false,
    python = "python3",
    timeoutMs = 240_000,
  } = input;
  await mkdir(dataHome, { recursive: true });
  await mkdir(binHome, { recursive: true });

  const args = [
    "tool",
    "install",
    ...(reinstall ? ["--force"] : []),
    "--python",
    python,
    packageSpec,
    ...withPackages.flatMap((pkg) => ["--with", pkg]),
  ];

  await runProcess("uv", args, {
    timeoutMs,
    env: createUvToolEnvironment({ dataHome, binHome }),
    maxBufferBytes: 2 * 1024 * 1024,
    outputMode: "truncate",
  });
}

export async function installPackagesWithGoInstall(input: {
  readonly binDir: string;
  readonly packages: readonly string[];
  readonly timeoutMs?: number;
}): Promise<void> {
  const { binDir, packages, timeoutMs = 240_000 } = input;
  await mkdir(binDir, { recursive: true });
  for (const packageSpec of packages) {
    await runProcess("go", ["install", packageSpec], {
      timeoutMs,
      env: createGoInstallEnvironment({ binDir }),
      maxBufferBytes: 2 * 1024 * 1024,
      outputMode: "truncate",
    });
  }
}

export async function loadInstalledModule<T>(installDir: string, specifier: string): Promise<T> {
  const requireFromInstallRoot = createRequire(join(installDir, "package.json"));
  const resolvedPath = requireFromInstallRoot.resolve(specifier);
  return import(pathToFileURL(resolvedPath).href) as Promise<T>;
}
