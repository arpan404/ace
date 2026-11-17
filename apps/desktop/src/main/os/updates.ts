import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HomeData } from "@ace/protocol";
import type { ReleaseLine } from "@ace/service/release-line";
import { isNewer } from "@ace/service/version";
import { checkReleaseFeed, githubReleases } from "./release-feed.ts";
import { noteGroups } from "./release-notes.ts";
import type { UpdateEngine } from "./update-controller.ts";

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
  // Quitting installs a downloaded update: quitting stops the app's daemon in any case.
  autoUpdater.autoInstallOnAppQuit = true;
  // Only for a release the picker chose below this version, after its guard (see `check`).
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (value?: unknown) => options.log("info", `updater: ${text(value)}`),
    warn: (value?: unknown) => options.log("warn", `updater: ${text(value)}`),
    error: (value?: unknown) => options.log("warn", `updater: ${text(value)}`),
    debug: () => {},
  };
  // Failures arrive through the promises below; an unheard "error" event would crash main.
  autoUpdater.on("error", () => {});
  let progress: ((percent: number) => void) | undefined;
  autoUpdater.on("download-progress", (event) => progress?.(event.percent));
  return {
    canInstall: await canReplaceItself(options),
    async check() {
      // The person hears back even when the network hangs.
      const found = await within(
        checkReleaseFeed(
          { fetch: options.fetch ?? globalThis.fetch, urls: githubReleases },
          { installed: options.version, line: options.line(), home: options.homeData() },
        ),
        updateCheckTimeoutMs,
        "The update check timed out.",
      );
      if (found.kind === "current") return undefined;
      if (found.kind === "blocked") return { blocked: found.message };
      autoUpdater.setFeedURL({ provider: "generic", url: found.feedUrl });
      // Semver ranks a beta of 0.0.23 below 0.0.23, so stable → that beta is a "downgrade" to
      // electron-updater too; otherwise only a switch the guard allowed goes down.
      autoUpdater.allowDowngrade = found.older || semverAbove(options.version, found.version);
      const result = await within(
        autoUpdater.checkForUpdates(),
        updateCheckTimeoutMs,
        "The update check timed out.",
      );
      if (!result?.isUpdateAvailable || result.updateInfo.version !== found.version)
        return undefined;
      return { version: found.version, releaseUrl: found.releaseUrl, ...noteGroups(found.notes) };
    },
    async download(report) {
      // Squirrel.Mac verifies the signature only after electron-updater's download resolves.
      const verdict = squirrel ? squirrelVerdict(squirrel) : undefined;
      progress = report;
      try {
        await autoUpdater.downloadUpdate();
        await verdict?.promise;
      } finally {
        progress = undefined;
        verdict?.dispose();
      }
    },
    install() {
      // Windows: silent, and start ace again afterwards. macOS and Linux ignore both.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}

interface SquirrelEvents {
  once(event: "update-downloaded" | "error", listener: (...args: unknown[]) => void): unknown;
  removeListener(
    event: "update-downloaded" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
}

function squirrelVerdict(squirrel: SquirrelEvents) {
  const held: {
    downloaded?: () => void;
    failed?: (error: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
  } = {};
  const dispose = () => {
    clearTimeout(held.timer);
    if (held.downloaded) squirrel.removeListener("update-downloaded", held.downloaded);
    if (held.failed) squirrel.removeListener("error", held.failed);
  };
  const promise = new Promise<void>((resolve, reject) => {
    held.downloaded = () => {
      dispose();
      resolve();
    };
    held.failed = (error: unknown) => {
      dispose();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    held.timer = setTimeout(
      () => held.failed?.(new Error("Squirrel did not stage the update in time")),
      squirrelVerdictMs,
    );
    squirrel.once("update-downloaded", held.downloaded);
    squirrel.once("error", held.failed);
  });
  // Awaited only after the download; a refusal before then must not go unhandled.
  promise.catch(() => {});
  return { promise, dispose };
}

function semverAbove(version: string, than: string): boolean {
  try {
    return isNewer(version, than);
  } catch {
    return false;
  }
}

function text(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
