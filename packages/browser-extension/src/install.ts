import { execFile } from "node:child_process";
import { access, chmod, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { userBrowserHostName } from "@ace/protocol";
import { extensionOrigin } from "./extension-id.ts";
import { launcherPath, userBrowserDir } from "./host-files.ts";
import { launcherScript, nativeHostManifest, nativeHostTargets } from "./native-hosts.ts";

export interface NativeHostInstall {
  browser: string;
  manifestPath: string;
}
/** Default values of HKCU keys. Only Windows registers native hosts this way. */
export interface NativeHostRegistry {
  read(keys: readonly string[]): Promise<(string | undefined)[]>;
  write(keys: readonly string[], value: string): Promise<void>;
  /** Clears each key's value only while it still equals `expected`. */
  remove(keys: readonly string[], expected: string): Promise<void>;
}
export interface InstallOptions {
  platform: NodeJS.Platform;
  home: string;
  dataDir: string;
  /** The Node executable that runs the host; the daemon passes its own. */
  node: string;
  env?: { XDG_CONFIG_HOME?: string | undefined; LOCALAPPDATA?: string | undefined };
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

/** Locations to register: each installed browser's, plus any extra directories. */
async function targets(options: Omit<InstallOptions, "node" | "dataDir">) {
  if (options.platform === "win32" && options.extraDirs?.length)
    throw new Error("Windows native hosts use per-user registry keys, not profile directories");
  const found: { browser: string; location: string }[] = [];
  for (const target of nativeHostTargets(options.platform, options.home, options.env))
    if (await exists(target.root)) found.push(target);
  for (const location of options.extraDirs ?? []) found.push({ browser: "Custom", location });
  return found;
}

/** Windows keeps one manifest in ace's data directory; registry keys point browsers at it. */
function windowsManifestPath(dataDir: string): string {
  return join(userBrowserDir(dataDir), manifestName);
}

/** Whether the manifest at `path` names this data directory's launcher. */
async function ownsManifest(path: string, launcher: string): Promise<boolean> {
  try {
    const file = await open(path, "r");
    let contents: string;
    try {
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) return false;
      contents = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
    const parsed = ManifestFile.safeParse(JSON.parse(contents));
    return parsed.success && parsed.data.path === launcher;
  } catch {
    return false;
  }
}

/**
 * Writes the launcher and a host manifest for every browser that has run on this account
 * (ADR 0084). Never touches a browser's profile or extension settings.
 */
export async function installNativeHost(options: InstallOptions): Promise<NativeHostInstall[]> {
  if (!installSupported(options.platform))
    throw new Error("Use my Chrome can't install its host on this platform yet");
  const found = await targets(options);
  const launcher = launcherPath(options.dataDir, options.platform);
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await writeFile(
    launcher,
    launcherScript(options.platform, {
      node: options.node,
      entry: hostEntry(),
      dataDir: options.dataDir,
    }),
    { mode: 0o755 },
  );
  await chmod(launcher, 0o755);
  const manifest = `${JSON.stringify(nativeHostManifest(launcher, [extensionOrigin]), null, 2)}\n`;
  if (options.platform === "win32") {
    const manifestPath = windowsManifestPath(options.dataDir);
    await writeFile(manifestPath, manifest, { mode: 0o644 });
    if (found.length)
      await (options.registry ?? hostRegistry).write(
        found.map((target) => target.location),
        manifestPath,
      );
    return found.map(({ browser }) => ({ browser, manifestPath }));
  }
  const installed: NativeHostInstall[] = [];
  for (const target of found) {
    await mkdir(target.location, { recursive: true });
    const manifestPath = join(target.location, manifestName);
    await writeFile(manifestPath, manifest, { mode: 0o644 });
    installed.push({ browser: target.browser, manifestPath });
  }
  return installed;
}

/** Hosts whose manifest points at this data directory's launcher. */
export async function installedNativeHosts(
  options: Omit<InstallOptions, "node">,
): Promise<NativeHostInstall[]> {
  const launcher = launcherPath(options.dataDir, options.platform);
  const found = await targets(options);
  if (options.platform === "win32") {
    const manifestPath = windowsManifestPath(options.dataDir);
    if (!found.length || !(await ownsManifest(manifestPath, launcher))) return [];
    const values = await (options.registry ?? hostRegistry).read(
      found.map((target) => target.location),
    );
    return found
      .filter((_, index) => values[index] === manifestPath)
      .map(({ browser }) => ({ browser, manifestPath }));
  }
  const installed: NativeHostInstall[] = [];
  for (const target of found) {
    const manifestPath = join(target.location, manifestName);
    if (await ownsManifest(manifestPath, launcher))
      installed.push({ browser: target.browser, manifestPath });
  }
  return installed;
}

/** Removes this data directory's manifests and launcher; another ace's manifests stay. */
export async function uninstallNativeHost(options: Omit<InstallOptions, "node">): Promise<void> {
  if (options.platform === "win32") {
    // The exact registered manifest path proves which installation owns a value,
    // even after its manifest or browser profile has disappeared.
    const manifestPath = windowsManifestPath(options.dataDir);
    await (options.registry ?? hostRegistry).remove(
      nativeHostTargets(options.platform, options.home, options.env).map(
        (target) => target.location,
      ),
      manifestPath,
    );
    await rm(manifestPath, { force: true });
  } else
    for (const host of await installedNativeHosts(options))
      await rm(host.manifestPath, { force: true });
  await rm(launcherPath(options.dataDir, options.platform), { force: true });
}

// PowerShell rather than reg.exe: reg.exe exits 1 with a localized message both for a missing
// key and for denied access, and writes non-ASCII values in the console code page when piped,
// so it can prove neither ownership of a Unicode manifest path nor that a key is absent. .NET
// returns null for a missing key and throws on denied access. Paths travel as base64 JSON.
// https://learn.microsoft.com/dotnet/api/microsoft.win32.registrykey
const registryScript = `
$ErrorActionPreference = 'Stop'
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
  $values = @()
  foreach ($path in $request.keys) {
    $key = $null
    try {
      if ($request.action -eq 'write') {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
        $key.SetValue('', [string]$request.value, [Microsoft.Win32.RegistryValueKind]::String)
      } else {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, ($request.action -eq 'remove'))
        $value = $null
        if ($null -ne $key) {
          $value = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          if ($null -ne $value -and $key.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'Native host registry value must be REG_SZ' }
          if ($request.action -eq 'remove' -and $value -ceq $request.value) { $key.DeleteValue('', $false) }
        }
        $values += $value
      }
    } finally {
      if ($null -ne $key) { $key.Dispose() }
    }
  }
  $json = ConvertTo-Json -InputObject @($values) -Compress
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

async function registryRequest(
  action: "read" | "write" | "remove",
  keys: readonly string[],
  value?: string,
): Promise<(string | undefined)[]> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(registryScript, "utf16le").toString("base64"),
      ],
      { timeout: 10_000, maxBuffer: 65_536, windowsHide: true, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      Buffer.from(JSON.stringify({ action, keys, value }), "utf8").toString("base64"),
    );
  });
  const encoded = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .parse(output);
  const values = z
    .array(z.string().nullable())
    .max(32)
    .parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
  if (action === "read" && values.length !== keys.length)
    throw new Error("Incomplete native host registry response");
  return values.map((entry) => entry ?? undefined);
}

/** The real HKCU registry. Lazy: importing this module never starts PowerShell. */
export const hostRegistry: NativeHostRegistry = {
  read: (keys) => registryRequest("read", keys),
  async write(keys, value) {
    await registryRequest("write", keys, value);
  },
  async remove(keys, expected) {
    await registryRequest("remove", keys, expected);
  },
};
