import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { userBrowserHostName } from "@ace/protocol";
import { extensionOrigin } from "./extension-id.ts";
import { launcherPath, userBrowserDir } from "./host-files.ts";
import {
  launcherScript,
  nativeHostManifest,
  nativeHostTargets,
  windowsHostKeys,
  windowsLauncherScript,
} from "./native-hosts.ts";

export interface NativeHostInstall {
  browser: string;
  manifestPath: string;
}
export interface InstallOptions {
  platform: NodeJS.Platform;
  home: string;
  dataDir: string;
  /** The Node executable that runs the host; the daemon passes its own. */
  node: string;
  env?: { XDG_CONFIG_HOME?: string | undefined; LOCALAPPDATA?: string | undefined };
  /** Windows only: the HKCU registry, replaced in tests. */
  registry?: NativeHostRegistry;
  /** More NativeMessagingHosts directories, for example a test browser's `<user-data-dir>`. */
  extraDirs?: readonly string[];
}

/**
 * The host entry Chrome runs through the launcher. Resolved on use, not at import: the daemon's
 * package graph also loads under test environments whose `import.meta.url` is not a file URL.
 */
const hostEntry = (): string => fileURLToPath(new URL("./host-main.ts", import.meta.url));
const manifestName = `${userBrowserHostName}.json`;
const ManifestFile = z.object({ name: z.literal(userBrowserHostName), path: z.string() });

export function installSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Directories to write: each installed browser's, plus any extra ones. */
async function targets(options: Omit<InstallOptions, "node" | "dataDir">) {
  const found: { browser: string; dir: string }[] = [];
  for (const target of nativeHostTargets(options.platform, options.home, options.env))
    if (await exists(target.root)) found.push(target);
  for (const dir of options.extraDirs ?? []) found.push({ browser: "Custom", dir });
  return found;
}

/**
 * Writes the launcher and a host manifest for every browser that has run on this account
 * (ADR 0084). Never touches a browser's profile or extension settings.
 */
export async function installNativeHost(options: InstallOptions): Promise<NativeHostInstall[]> {
  if (options.platform === "win32") return installWindowsHost(options);
  if (!installSupported(options.platform))
    throw new Error("Use my Chrome can't install its host on this platform yet");
  const launcher = launcherPath(options.dataDir);
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await writeFile(
    launcher,
    launcherScript({ node: options.node, entry: hostEntry(), dataDir: options.dataDir }),
    { mode: 0o755 },
  );
  await chmod(launcher, 0o755);
  const manifest = `${JSON.stringify(nativeHostManifest(launcher, [extensionOrigin]), null, 2)}\n`;
  const installed: NativeHostInstall[] = [];
  for (const target of await targets(options)) {
    await mkdir(target.dir, { recursive: true });
    const manifestPath = join(target.dir, manifestName);
    await writeFile(manifestPath, manifest, { mode: 0o644 });
    installed.push({ browser: target.browser, manifestPath });
  }
  return installed;
}

/** Manifests that point at this data directory's launcher. */
export async function installedNativeHosts(
  options: Omit<InstallOptions, "node">,
): Promise<NativeHostInstall[]> {
  if (options.platform === "win32") return installedWindowsHosts(options);
  const launcher = launcherPath(options.dataDir);
  const installed: NativeHostInstall[] = [];
  for (const target of await targets(options)) {
    const manifestPath = join(target.dir, manifestName);
    const parsed = ManifestFile.safeParse(
      await readFile(manifestPath, "utf8").then(
        (text) => JSON.parse(text) as unknown,
        () => undefined,
      ),
    );
    if (parsed.success && parsed.data.path === launcher)
      installed.push({ browser: target.browser, manifestPath });
  }
  return installed;
}

/** Removes this data directory's manifests and launcher; another ace's manifests stay. */
export async function uninstallNativeHost(options: Omit<InstallOptions, "node">): Promise<void> {
  if (options.platform === "win32") return uninstallWindowsHost(options);
  for (const host of await installedNativeHosts(options))
    await rm(host.manifestPath, { force: true });
  await rm(launcherPath(options.dataDir), { force: true });
}

// Windows: one manifest in ace's data directory, and an HKCU key per browser pointing at it.

/** Default values of HKCU keys. */
export interface NativeHostRegistry {
  read(keys: readonly string[]): Promise<(string | undefined)[]>;
  write(keys: readonly string[], value: string): Promise<void>;
  /** Clears each key's value only while it still equals `expected`. */
  remove(keys: readonly string[], expected: string): Promise<void>;
}

const windowsManifestPath = (dataDir: string) => join(userBrowserDir(dataDir), manifestName);

async function windowsTargets(options: Omit<InstallOptions, "node" | "dataDir">) {
  if (options.extraDirs?.length)
    throw new Error("Windows native hosts use per-user registry keys, not profile directories");
  const found = [];
  for (const target of windowsHostKeys(options.home, options.env))
    if (await exists(target.root)) found.push(target);
  return found;
}

async function installWindowsHost(options: InstallOptions): Promise<NativeHostInstall[]> {
  const found = await windowsTargets(options);
  const launcher = launcherPath(options.dataDir, "win32");
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await writeFile(
    launcher,
    windowsLauncherScript({ node: options.node, entry: hostEntry(), dataDir: options.dataDir }),
  );
  const manifestPath = windowsManifestPath(options.dataDir);
  const manifest = `${JSON.stringify(nativeHostManifest(launcher, [extensionOrigin]), null, 2)}\n`;
  await writeFile(manifestPath, manifest);
  if (found.length)
    await (options.registry ?? hostRegistry).write(
      found.map((target) => target.key),
      manifestPath,
    );
  return found.map(({ browser }) => ({ browser, manifestPath }));
}

async function installedWindowsHosts(
  options: Omit<InstallOptions, "node">,
): Promise<NativeHostInstall[]> {
  const manifestPath = windowsManifestPath(options.dataDir);
  const found = await windowsTargets(options);
  const parsed = ManifestFile.safeParse(
    await readFile(manifestPath, "utf8").then(
      (text) => JSON.parse(text) as unknown,
      () => undefined,
    ),
  );
  if (
    !found.length ||
    !parsed.success ||
    parsed.data.path !== launcherPath(options.dataDir, "win32")
  )
    return [];
  const values = await (options.registry ?? hostRegistry).read(found.map((target) => target.key));
  return found
    .filter((_, index) => values[index] === manifestPath)
    .map(({ browser }) => ({ browser, manifestPath }));
}

async function uninstallWindowsHost(options: Omit<InstallOptions, "node">): Promise<void> {
  // The exact registered manifest path proves ownership, even after the manifest or profile is gone.
  const manifestPath = windowsManifestPath(options.dataDir);
  await (options.registry ?? hostRegistry).remove(
    windowsHostKeys(options.home, options.env).map((target) => target.key),
    manifestPath,
  );
  await rm(manifestPath, { force: true });
  await rm(launcherPath(options.dataDir, "win32"), { force: true });
}

function reg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("reg.exe", args, { timeout: 10_000, maxBuffer: 65_536, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

/** One key's default value. `reg export` writes UTF-16, so Unicode paths survive. */
async function readKey(key: string, file: string): Promise<string | undefined> {
  try {
    await reg(["export", `HKCU\\${key}`, file, "/y"]);
  } catch {
    // A missing key, and on one's own HKCU only an unreadable one, reads as unregistered.
    return undefined;
  }
  const line = (await readFile(file))
    .toString("utf16le")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("@="));
  if (line === undefined) return undefined;
  const value = /^@="((?:[^"\\]|\\.)*)"$/.exec(line)?.[1];
  if (value === undefined) throw new Error("Native host registry value must be REG_SZ");
  return value.replaceAll(/\\(.)/g, "$1");
}

async function readKeys(keys: readonly string[]): Promise<(string | undefined)[]> {
  const dir = await mkdtemp(join(tmpdir(), "ace-native-host-"));
  try {
    const values = [];
    for (const [index, key] of keys.entries())
      values.push(await readKey(key, join(dir, `${index}.reg`)));
    return values;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The real HKCU registry through the built-in reg.exe. */
export const hostRegistry: NativeHostRegistry = {
  read: readKeys,
  async write(keys, value) {
    for (const key of keys)
      await reg(["add", `HKCU\\${key}`, "/ve", "/t", "REG_SZ", "/d", value, "/f"]);
  },
  async remove(keys, expected) {
    const values = await readKeys(keys);
    for (const [index, key] of keys.entries())
      if (values[index] === expected) await reg(["delete", `HKCU\\${key}`, "/ve", "/f"]);
  },
};
