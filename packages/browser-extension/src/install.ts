import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { userBrowserHostName } from "@ace/protocol";
import { extensionOrigin } from "./extension-id.ts";
import { launcherPath } from "./host-files.ts";
import { launcherScript, nativeHostManifest, nativeHostTargets } from "./native-hosts.ts";

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
  env?: { XDG_CONFIG_HOME?: string | undefined };
  /** More NativeMessagingHosts directories, for example a test browser's `<user-data-dir>`. */
  extraDirs?: readonly string[];
}

/** The host entry Chrome runs through the launcher. */
export const hostEntry = fileURLToPath(new URL("./host-main.ts", import.meta.url));
const manifestName = `${userBrowserHostName}.json`;
const ManifestFile = z.object({ name: z.literal(userBrowserHostName), path: z.string() });

export function installSupported(platform: NodeJS.Platform): boolean {
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
  if (!installSupported(options.platform))
    throw new Error("Use my Chrome can't install its host on this platform yet");
  const launcher = launcherPath(options.dataDir);
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await writeFile(
    launcher,
    launcherScript({ node: options.node, entry: hostEntry, dataDir: options.dataDir }),
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
  for (const host of await installedNativeHosts(options))
    await rm(host.manifestPath, { force: true });
  await rm(launcherPath(options.dataDir), { force: true });
}
