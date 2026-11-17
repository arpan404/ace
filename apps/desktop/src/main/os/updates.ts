import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HomeData } from "@ace/protocol";
import type { ReleaseLine } from "@ace/service/release-line";
import { githubReleases } from "./release-feed.ts";
import type { UpdateEngine } from "./update-controller.ts";
import { feedEngine } from "./update-engine.ts";

const updateCheckTimeoutMs = 15_000;
/** How long Squirrel.Mac may take to verify and stage a downloaded update. */
const squirrelVerdictMs = 10 * 60_000;

export interface EngineOptions {
  version: string;
  platform: NodeJS.Platform;
  /** `process.resourcesPath`: electron-builder writes `app-update.yml` there. */
  resourcesPath: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  /** The line the person updates from now (ADR 0174). */
  line(): ReleaseLine;
  /** What the home holds, as the daemon last said; undefined until it has. */
  homeData(): HomeData | undefined;
  /** What the home holds now, asked of the daemon; undefined when it can't say. */
  freshHomeData(): Promise<HomeData | undefined>;
  fetch?: typeof globalThis.fetch;
  log(level: "info" | "warn", message: string): void;
}

/**
 * electron-updater on the release the app picked (ADR 0091, 0174), or undefined for a build
 * without a feed (`app-update.yml` is written only by release packaging). The release feed
 * (`release-feed.ts`) picks the release for the person's line from GitHub's release list; the
 * generic provider then reads that release's own folder. electron-updater checks each
 * download's SHA-512 against the release's `latest*.yml`; on macOS Squirrel.Mac also requires
 * the update to carry the running app's code signature.
 */
export async function electronUpdateEngine(
  options: EngineOptions,
): Promise<UpdateEngine | undefined> {
  if (!existsSync(join(options.resourcesPath, "app-update.yml"))) return undefined;
  // electron-updater is CommonJS: its exports arrive as `default`, both when Node loads it
  // and in the bundled chunk, where named exports are not filled in.
  const { autoUpdater } = (await import("electron-updater")).default;
  const squirrel = options.platform === "darwin" ? (await import("electron")).autoUpdater : null;
  autoUpdater.autoDownload = false;
  // Quitting installs a downloaded update: quitting stops the app's daemon in any case. The
  // engine turns this off for a switch to an older release (`update-engine.ts`).
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (value?: unknown) => options.log("info", `updater: ${text(value)}`),
    warn: (value?: unknown) => options.log("warn", `updater: ${text(value)}`),
    error: (value?: unknown) => options.log("warn", `updater: ${text(value)}`),
    debug: () => {},
  };
  // Failures arrive through the engine's promises; an unheard "error" event would crash main.
  autoUpdater.on("error", () => {});
  return feedEngine({
    updater: autoUpdater,
    squirrel,
    canInstall: await canReplaceItself(options),
    installed: options.version,
    line: options.line,
    homeData: options.homeData,
    freshHomeData: options.freshHomeData,
    feed: { fetch: options.fetch ?? globalThis.fetch, urls: githubReleases },
    onProgress: (listener) =>
      autoUpdater.on("download-progress", (event) => listener(event.percent)),
    checkTimeoutMs: updateCheckTimeoutMs,
    squirrelVerdictMs,
    log: options.log,
  });
}

function text(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Whether the installed app can update in place. macOS: Squirrel only accepts an update
 * signed by the same Developer ID, so an ad-hoc signed build opens the release instead.
 * Linux: only an AppImage replaces itself; a deb or rpm is updated by its package manager.
 */
async function canReplaceItself(options: EngineOptions): Promise<boolean> {
  if (options.platform === "win32") return true;
  if (options.platform === "linux") return Boolean(options.env.APPIMAGE);
  if (options.platform !== "darwin") return false;
  const bundle = dirname(dirname(dirname(options.execPath)));
  const details = await new Promise<string>((resolve) =>
    execFile("/usr/bin/codesign", ["-dv", "--verbose=2", bundle], (_error, stdout, stderr) =>
      resolve(`${stdout}${stderr}`),
    ),
  );
  return developerIdSigned(details);
}

/** `codesign -dv` output of an app signed by a team (not ad-hoc, not unsigned). */
export function developerIdSigned(details: string): boolean {
  if (/Signature=adhoc/.test(details)) return false;
  const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1]?.trim();
  return Boolean(team && team !== "not set");
}
