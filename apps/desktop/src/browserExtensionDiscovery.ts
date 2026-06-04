import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const KNOWN_PASSWORD_MANAGER_EXTENSION_IDS = new Set([
  "aeblfdkhhhdcdjpifhhbdiojplfjncoa", // 1Password
  "bfogiafebfohielmmehodmfbbebbbpei", // Keeper
  "fdjamakpfbbddfjaooikfcpapjohcfmg", // Dashlane
  "ghmbeldphafepmbegfdlkpapadhbakde", // Proton Pass
  "hdokiejnpimakedhajhdlcegeplioahd", // LastPass
  "kmcfomidfpdkfieipokbalgegidffkal", // Enpass
  "nngceckbapebfimnlniiiahkandclblb", // Bitwarden
  "pejdijmoenmkgeppbflobdenhhabjlaj", // iCloud Passwords
]);

export interface BrowserExtensionDiscoveryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly existsSync?: (path: string) => boolean;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly readdirSync?: typeof FS.readdirSync;
  readonly statSync?: typeof FS.statSync;
}

function resolveEnvExtensionDirectories(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly existsSync: (path: string) => boolean;
}): string[] {
  const rawValue = input.env.ACE_DESKTOP_BROWSER_EXTENSION_DIRS;
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(Path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && input.existsSync(entry));
}

function resolveChromiumProfileRoots(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
}): string[] {
  if (input.platform === "darwin") {
    const appSupport = Path.join(input.homeDir, "Library", "Application Support");
    return [
      Path.join(appSupport, "Google", "Chrome"),
      Path.join(appSupport, "Chromium"),
      Path.join(appSupport, "BraveSoftware", "Brave-Browser"),
      Path.join(appSupport, "Microsoft Edge"),
      Path.join(appSupport, "Vivaldi"),
      Path.join(appSupport, "Arc", "User Data"),
    ];
  }

  if (input.platform === "win32") {
    const localAppData = input.env.LOCALAPPDATA;
    if (!localAppData) {
      return [];
    }
    return [
      Path.join(localAppData, "Google", "Chrome", "User Data"),
      Path.join(localAppData, "Chromium", "User Data"),
      Path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
      Path.join(localAppData, "Microsoft", "Edge", "User Data"),
      Path.join(localAppData, "Vivaldi", "User Data"),
    ];
  }

  const configHome = input.env.XDG_CONFIG_HOME || Path.join(input.homeDir, ".config");
  return [
    Path.join(configHome, "google-chrome"),
    Path.join(configHome, "chromium"),
    Path.join(configHome, "BraveSoftware", "Brave-Browser"),
    Path.join(configHome, "microsoft-edge"),
    Path.join(configHome, "vivaldi"),
  ];
}

function isProfileDirectoryName(name: string): boolean {
  return name === "Default" || /^Profile \d+$/u.test(name);
}

function readDirectoryNames(input: {
  readonly path: string;
  readonly readdirSync: typeof FS.readdirSync;
}): string[] {
  try {
    return input
      .readdirSync(input.path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function hasManifest(input: {
  readonly existsSync: (path: string) => boolean;
  readonly extensionVersionDirectory: string;
}): boolean {
  return input.existsSync(Path.join(input.extensionVersionDirectory, "manifest.json"));
}

function compareVersionNames(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (!Number.isFinite(leftPart) || !Number.isFinite(rightPart)) {
      return left.localeCompare(right);
    }
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

function resolveNewestExtensionVersionDirectory(input: {
  readonly existsSync: (path: string) => boolean;
  readonly extensionDirectory: string;
  readonly readdirSync: typeof FS.readdirSync;
  readonly statSync: typeof FS.statSync;
}): string | null {
  const candidates = readDirectoryNames({
    path: input.extensionDirectory,
    readdirSync: input.readdirSync,
  })
    .map((versionName) => ({
      extensionVersionDirectory: Path.join(input.extensionDirectory, versionName),
      versionName,
    }))
    .filter((candidate) =>
      hasManifest({
        existsSync: input.existsSync,
        extensionVersionDirectory: candidate.extensionVersionDirectory,
      }),
    )
    .map((candidate) => {
      let mtimeMs = 0;
      try {
        mtimeMs = input.statSync(candidate.extensionVersionDirectory).mtimeMs;
      } catch {
        // Missing or unreadable extension versions are still sortable by version name.
      }
      return {
        extensionVersionDirectory: candidate.extensionVersionDirectory,
        mtimeMs,
        versionName: candidate.versionName,
      };
    })
    .toSorted((left, right) => {
      const versionComparison = compareVersionNames(right.versionName, left.versionName);
      return versionComparison === 0 ? right.mtimeMs - left.mtimeMs : versionComparison;
    });

  return candidates[0]?.extensionVersionDirectory ?? null;
}

function discoverPasswordManagerExtensionDirectories(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly existsSync: (path: string) => boolean;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly readdirSync: typeof FS.readdirSync;
  readonly statSync: typeof FS.statSync;
}): string[] {
  const byExtensionId = new Map<string, string>();
  for (const root of resolveChromiumProfileRoots(input)) {
    if (!input.existsSync(root)) {
      continue;
    }
    for (const profileName of readDirectoryNames({ path: root, readdirSync: input.readdirSync })) {
      if (!isProfileDirectoryName(profileName)) {
        continue;
      }
      const extensionsRoot = Path.join(root, profileName, "Extensions");
      for (const extensionId of KNOWN_PASSWORD_MANAGER_EXTENSION_IDS) {
        const extensionDirectory = Path.join(extensionsRoot, extensionId);
        if (!input.existsSync(extensionDirectory) || byExtensionId.has(extensionId)) {
          continue;
        }
        const extensionVersionDirectory = resolveNewestExtensionVersionDirectory({
          existsSync: input.existsSync,
          extensionDirectory,
          readdirSync: input.readdirSync,
          statSync: input.statSync,
        });
        if (extensionVersionDirectory) {
          byExtensionId.set(extensionId, extensionVersionDirectory);
        }
      }
    }
  }

  return [...byExtensionId.values()];
}

export function resolveBrowserExtensionDirectories(
  options: BrowserExtensionDiscoveryOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? FS.existsSync;
  const homeDir = options.homeDir ?? OS.homedir();
  const platform = options.platform ?? process.platform;
  const readdirSync = options.readdirSync ?? FS.readdirSync;
  const statSync = options.statSync ?? FS.statSync;
  const seen = new Set<string>();
  const directories = [
    ...resolveEnvExtensionDirectories({ env, existsSync }),
    ...discoverPasswordManagerExtensionDirectories({
      env,
      existsSync,
      homeDir,
      platform,
      readdirSync,
      statSync,
    }),
  ];

  return directories.filter((directory) => {
    const normalized = Path.resolve(directory);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}
