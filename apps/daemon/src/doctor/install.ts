import { dirname, join } from "node:path";
import { detectToolchains } from "@ace/diagnostics/toolchains";
import { DaemonHealth, ReleaseVersion, type Toolchain } from "@ace/protocol";
import { DesktopApp, desktopAppMarker } from "@ace/service/desktop-update";
import type { DoctorContext, DoctorFeature } from "./feature.ts";
import { dataFormatVerdict, storedFormat } from "./install-data-format.ts";
import { aceOnPath, pathVerdict, readHead } from "./install-path.ts";
import { optionalTools, toolchainVerdict, type OptionalTool } from "./install-toolchains.ts";
import { aceAppVersion, cliOrigin, versionsVerdict, type VersionSide } from "./install-versions.ts";

/** What the install checks read beyond the doctor context, so tests can stand in for it. */
export type InstallPorts = {
  /** The running CLI's entry script (`process.argv[1]`). */
  cliEntry: string | undefined;
  /** Where the desktop app may be installed. */
  desktopApps(context: DoctorContext): string[];
  /** The running daemon's reported version, or undefined when it's down or doesn't say. */
  daemonVersion(context: DoctorContext): Promise<string | undefined>;
  toolchains(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<Toolchain[]>;
};

async function appVersion(bundle: string): Promise<string | undefined> {
  const plist = await readHead(join(bundle, "Contents", "Info.plist"), 64 * 1024);
  return plist ? aceAppVersion(plist) : undefined;
}

/**
 * The app version the desktop build writes beside its bundled daemon (`daemon/desktop-app.json`),
 * when `entry` is that daemon's `ace.mjs`. It ships inside the app, so an app upgrade replaces it
 * along with the CLI itself, however old the `ace` launcher that runs it.
 */
async function bundledAppVersion(entry: string): Promise<string | undefined> {
  const text = await readHead(join(dirname(entry), desktopAppMarker), 4096);
  if (!text) return undefined;
  try {
    return DesktopApp.safeParse(JSON.parse(text)).data?.version;
  } catch {
    return undefined;
  }
}

/**
 * The running CLI's version: a stamped `ACE_VERSION`, else the release folder its entry script
 * lives in, else the desktop app it is bundled in (its `desktop-app.json`, then on macOS the
 * bundle's Info.plist), else "development". `ace --version` and the doctor's version check
 * share it.
 */
export async function cliVersion(
  env: NodeJS.ProcessEnv,
  entry: string | undefined,
): Promise<string> {
  const stamped = env.ACE_VERSION;
  if (stamped !== undefined) return ReleaseVersion.safeParse(stamped).data ?? "development";
  const origin = cliOrigin(entry);
  if (origin?.kind === "release") return origin.version;
  const bundled = entry ? await bundledAppVersion(entry) : undefined;
  if (bundled) return bundled;
  const version = origin ? await appVersion(origin.bundle) : undefined;
  return version ?? "development";
}

async function cliSide(context: DoctorContext, entry: string | undefined): Promise<VersionSide> {
  return { kind: "cli", version: await cliVersion(context.env, entry) };
}

async function versionSides(
  context: DoctorContext,
  ports: InstallPorts,
): Promise<{ sides: VersionSide[]; note?: string }> {
  const sides = [await cliSide(context, ports.cliEntry)];
  const daemon = await ports.daemonVersion(context);
  if (daemon !== undefined) sides.push({ kind: "daemon", version: daemon });
  if (context.platform === "darwin")
    for (const bundle of ports.desktopApps(context)) {
      const version = await appVersion(bundle);
      if (version) sides.push({ kind: "desktop", version, where: bundle });
    }
  if (daemon !== undefined) return { sides };
  return {
    sides,
    note:
      context.daemonState === "running"
        ? "the daemon is running but didn't report its version"
        : "the daemon isn't running",
  };
}

/** The local daemon's `/v1/status`, the same endpoint `ace access status` reads. */
async function localDaemonVersion(context: DoctorContext): Promise<string | undefined> {
  if (context.daemonState !== "running") return undefined;
  try {
    // Loaded only when the daemon runs, like the doctor's client.
    const { hostConnection } = await import("../cli/connection.ts");
    const { accessRequest } = await import("../client-access.ts");
    const { origin, token } = hostConnection(context.config.dataDir);
    const health = DaemonHealth.loose().safeParse(
      await accessRequest(origin, "/v1/status", { token, now: context.now }),
    );
    return health.data?.version;
  } catch {
    return undefined;
  }
}

export const systemInstallPorts: InstallPorts = {
  cliEntry: process.argv[1],
  desktopApps: (context) => [
    "/Applications/ace.app",
    join(context.home, "Applications", "ace.app"),
  ],
  daemonVersion: localDaemonVersion,
  toolchains: (env, platform) => detectToolchains(env, platform),
};

/**
 * Install and versions: whether the CLI, daemon and desktop app agree, whether this build can
 * read the data folder, which `ace` runs from PATH, and the optional simulator toolchains.
 */
export function installFeature(ports: InstallPorts): DoctorFeature {
  return {
    id: "install",
    checks(context) {
      let toolchains: Promise<Toolchain[]> | undefined;
      const detected = () => (toolchains ??= ports.toolchains(context.env, context.platform));
      const tools: OptionalTool[] =
        context.platform === "darwin" ? ["xcode", "android"] : ["android"];
      return [
        {
          id: "install.versions",
          fix: "Update the older parts of ace to the same release.",
          timeoutMs: 15_000,
          async run() {
            const { sides, note } = await versionSides(context, ports);
            return versionsVerdict(sides, note);
          },
        },
        {
          id: "install.data-format",
          fix: "Update ace to the newest release.",
          async run() {
            const dataDir = context.config.dataDir;
            return dataFormatVerdict(dataDir, await storedFormat(dataDir));
          },
        },
        {
          id: "install.cli-path",
          fix: "Keep one ace installation on PATH.",
          async run() {
            return pathVerdict(await aceOnPath(context.env, context.platform));
          },
        },
        ...tools.map((id) => ({
          id: `install.${id}`,
          fix: `Optional: install ${optionalTools[id].name} for ${optionalTools[id].purpose}.`,
          timeoutMs: 30_000,
          async run() {
            const found = (await detected()).find((tool) => tool.id === id);
            return toolchainVerdict(id, found);
          },
        })),
      ];
    },
  };
}

export const install: DoctorFeature = installFeature(systemInstallPorts);
