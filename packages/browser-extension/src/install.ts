import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { userBrowserHostName } from "@ace/protocol";
import { extensionOrigin } from "./extension-id.ts";
import { launcherPath } from "./host-files.ts";
import { launcherScript, nativeHostManifest, nativeHostTargets } from "./native-hosts.ts";
// Windows only.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { userBrowserDir } from "./host-files.ts";
import { windowsHostKeys, windowsLauncherScript, windowsLocalAppData } from "./native-hosts.ts";

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
  if (platform === "win32") return true;
  return platform === "darwin" || platform === "linux";
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

type WindowsOptions = Omit<InstallOptions, "node" | "dataDir">;

/** ace's per-user native host directory. Its path never holds the data directory's text. */
const windowsHostsDir = (options: WindowsOptions) =>
  join(windowsLocalAppData(options.home, options.env), "ace", "native-hosts");

/**
 * Chrome starts Windows hosts as `cmd /d /c ""<launcher>" <origin> ..."`, so cmd expands `%NAME%`
 * (and `!NAME!` under delayed expansion) in the launcher's own path before it runs. The launcher
 * lives in a short per-data-directory folder instead of the data directory.
 */
function windowsLauncherPath(options: Omit<InstallOptions, "node">): string {
  const id = createHash("sha256").update(options.dataDir).digest("hex").slice(0, 16);
  return join(windowsHostsDir(options), id, "ace-native-host.cmd");
}

async function windowsTargets(options: WindowsOptions) {
  if (options.extraDirs?.length)
    throw new Error("Windows native hosts use per-user registry keys, not profile directories");
  const found = [];
  for (const target of windowsHostKeys(options.home, options.env))
    if (await exists(target.root)) found.push(target);
  return found;
}

const lockStaleMs = 30_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Serializes this user's registry writes and removals across ace processes, so an uninstall's
 * read-then-delete never removes a registration another data directory wrote in between. A lock
 * whose owner has exited, or that is older than any registry update, is broken automatically.
 */
async function withRegistryLock<T>(options: WindowsOptions, work: () => Promise<T>): Promise<T> {
  const dir = windowsHostsDir(options);
  await mkdir(dir, { recursive: true });
  const lock = join(dir, "registry.lock");
  const owner = `${process.pid} ${randomUUID()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(lock, owner, { flag: "wx" });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Another data directory's uninstall removed the emptied folder: make it again.
      if (code === "ENOENT" && attempt < 20) {
        await mkdir(dir, { recursive: true });
        continue;
      }
      if (code !== "EEXIST") throw error;
    }
    const held = await readFile(lock, "utf8").catch(() => undefined);
    const age = await stat(lock).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    // An empty lock is one being written right now; only age makes it stale.
    const pid = Number(held?.split(" ")[0]);
    const stale =
      held !== undefined &&
      (age > lockStaleMs || (held !== "" && (!(pid > 0) || !processAlive(pid))));
    // Re-read right before removing so a lock taken over meanwhile stays.
    if (stale && (await readFile(lock, "utf8").catch(() => undefined)) === held)
      await rm(lock, { force: true });
    else await new Promise((resolve) => setTimeout(resolve, Math.min(20 * 2 ** attempt, 500)));
  }
  try {
    return await work();
  } finally {
    if ((await readFile(lock, "utf8").catch(() => undefined)) === owner)
      await rm(lock, { force: true });
  }
}

async function installWindowsHost(options: InstallOptions): Promise<NativeHostInstall[]> {
  const found = await windowsTargets(options);
  const launcher = windowsLauncherPath(options);
  if (/[%!]/.test(launcher))
    throw new Error(
      `Use my Chrome can't install its host because Chrome's cmd.exe would rewrite % or ! in ${launcher}`,
    );
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(
    launcher,
    windowsLauncherScript({ node: options.node, entry: hostEntry(), dataDir: options.dataDir }),
  );
  const manifestPath = windowsManifestPath(options.dataDir);
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  const manifest = `${JSON.stringify(nativeHostManifest(launcher, [extensionOrigin]), null, 2)}\n`;
  await writeFile(manifestPath, manifest);
  if (found.length)
    await withRegistryLock(options, () =>
      (options.registry ?? hostRegistry).write(
        found.map((target) => target.key),
        manifestPath,
      ),
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
  if (!found.length || !parsed.success || parsed.data.path !== windowsLauncherPath(options))
    return [];
  const values = await (options.registry ?? hostRegistry).read(found.map((target) => target.key));
  return found
    .filter((_, index) => values[index] === manifestPath)
    .map(({ browser }) => ({ browser, manifestPath }));
}

async function uninstallWindowsHost(options: Omit<InstallOptions, "node">): Promise<void> {
  // The exact registered manifest path proves ownership, even after the manifest or profile is gone.
  const manifestPath = windowsManifestPath(options.dataDir);
  await withRegistryLock(options, () =>
    (options.registry ?? hostRegistry).remove(
      windowsHostKeys(options.home, options.env).map((target) => target.key),
      manifestPath,
    ),
  );
  await rm(manifestPath, { force: true });
  // A host that is still starting may hold its launcher a moment longer.
  await rm(dirname(windowsLauncherPath(options)), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  // The last data directory's uninstall leaves no empty host folder; another's launcher keeps it.
  await rmdir(windowsHostsDir(options)).catch(() => {});
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
