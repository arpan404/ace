import { access, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { userBrowserHostName } from "@ace/protocol";
import { launcherPath, userBrowserDir } from "./host-files.ts";
import { nativeHostManifest } from "./native-hosts.ts";
import { windowsRegistry, type RegistryKey } from "./windows-registry.ts";
import type { InstallOptions, NativeHostInstall } from "./install.ts";

// Documented HKCU interfaces, not inferred vendor names:
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
// https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/native-messaging
const browsers = [
  ["Chrome", "Google/Chrome/User Data", "Google\\Chrome"],
  ["Edge", "Microsoft/Edge/User Data", "Microsoft\\Edge"],
  ["Chromium", "Chromium/User Data", "Chromium"],
] as const;
const manifestName = `${userBrowserHostName}.json`;

function batchWord(value: string): string {
  if (/[\r\n\0"]/.test(value)) throw new Error("Invalid native host path");
  return `"${value.replaceAll("%", "%%")}"`;
}
export function windowsLauncher(options: { node: string; entry: string; dataDir: string }): string {
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${batchWord(options.node)} ${batchWord(options.entry)} --data-dir ${batchWord(options.dataDir)} %*\r\n`;
}

function registryTargets(options: Omit<InstallOptions, "node">) {
  const local = options.env?.LOCALAPPDATA ?? join(options.home, "AppData", "Local");
  return browsers.map(([browser, path, vendor]) => {
    const key = `Software\\${vendor}\\NativeMessagingHosts\\${userBrowserHostName}`;
    const keys: RegistryKey[] = [
      { key, view: 32 },
      { key, view: 64 },
    ];
    return { browser, root: join(local, path), keys };
  });
}

async function targets(options: Omit<InstallOptions, "node">) {
  const result = [];
  for (const target of registryTargets(options)) {
    if (
      await access(target.root).then(
        () => true,
        () => false,
      )
    )
      result.push(target);
  }
  return result;
}

export async function installWindowsHost(
  options: InstallOptions,
  entry: string,
  origin: string,
): Promise<NativeHostInstall[]> {
  if (options.extraDirs?.length)
    throw new Error(
      "Windows native hosts use per-user registry registration, not profile directories",
    );
  const launcher = launcherPath(options.dataDir, "win32");
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await writeFile(launcher, windowsLauncher({ ...options, entry }), { mode: 0o700 });
  const manifestPath = join(userBrowserDir(options.dataDir), manifestName);
  await writeFile(manifestPath, JSON.stringify(nativeHostManifest(launcher, [origin])) + "\n");
  const found = await targets(options);
  if (found.length)
    await (options.registry ?? windowsRegistry).write(
      found.flatMap((target) => target.keys),
      manifestPath,
    );
  return found.map(({ browser }) => ({ browser, manifestPath }));
}

async function ownManifest(options: Omit<InstallOptions, "node">): Promise<string | undefined> {
  const path = join(userBrowserDir(options.dataDir), manifestName);
  try {
    const file = await open(path, "r");
    let contents: string;
    try {
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) return undefined;
      contents = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
    const parsed = z
      .object({ name: z.literal(userBrowserHostName), path: z.string() })
      .safeParse(JSON.parse(contents));
    return parsed.success && parsed.data.path === launcherPath(options.dataDir, "win32")
      ? path
      : undefined;
  } catch {
    return undefined;
  }
}

export async function installedWindowsHosts(
  options: Omit<InstallOptions, "node">,
): Promise<NativeHostInstall[]> {
  const manifestPath = await ownManifest(options);
  if (!manifestPath) return [];
  const found = await targets(options);
  if (!found.length) return [];
  const values = await (options.registry ?? windowsRegistry).read(
    found.flatMap((target) => target.keys),
  );
  return found
    .filter(
      (_, index) => values[index * 2] === manifestPath || values[index * 2 + 1] === manifestPath,
    )
    .map(({ browser }) => ({ browser, manifestPath }));
}

export async function uninstallWindowsHost(options: Omit<InstallOptions, "node">): Promise<void> {
  // The exact registered manifest path proves which installation owns a value,
  // even after its manifest or browser profile has disappeared.
  const manifestPath = join(userBrowserDir(options.dataDir), manifestName);
  await (options.registry ?? windowsRegistry).remove(
    registryTargets(options).flatMap((target) => target.keys),
    manifestPath,
  );
  await rm(manifestPath, { force: true });
  await rm(launcherPath(options.dataDir, "win32"), { force: true });
}
