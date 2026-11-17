import type { HomeData, ReleaseData } from "@ace/protocol";
import { releaseLineOf, type ReleaseLine } from "@ace/service/release-line";
import { checkReleaseFeed, type FeedPorts } from "./release-feed.ts";
import { noteGroups } from "./release-notes.ts";
import { blockedSentence, guardSwitch } from "./release-picker.ts";
import type { UpdateEngine } from "./update-controller.ts";

/**
 * The update engine over the release the app picked (ADR 0091, 0177): the release feed chooses,
 * electron-updater's generic provider reads that release's folder, checks the SHA-512 and
 * downloads. electron-updater sits behind `FeedUpdater` so the engine's own decisions can be
 * tested without Electron.
 *
 * - Download and install are tied to the offer of the last check that succeeded. A check that
 *   timed out may still finish inside electron-updater and point it at another release, so a
 *   download first points it back at the offer and confirms the version it reads.
 * - A switch to an older release never installs on quit, and on macOS never reaches Squirrel
 *   until the person installs it. Before a download or an install the guard runs again on the
 *   home's data as the daemon reads it then (`recheck`); a release it now refuses is dropped.
 */

/** The parts of electron-updater's `AppUpdater` the engine drives. */
export interface FeedUpdater {
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<{
    isUpdateAvailable: boolean;
    updateInfo: { version: string };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** Squirrel.Mac's events, as Electron's `autoUpdater` gives them. */
export interface SquirrelEvents {
  once(event: "update-downloaded" | "error", listener: (...args: unknown[]) => void): unknown;
  removeListener(
    event: "update-downloaded" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
}

export interface FeedEnginePorts {
  updater: FeedUpdater;
  /** Squirrel.Mac on macOS, which verifies the signature after the download; else null. */
  squirrel: SquirrelEvents | null;
  canInstall: boolean;
  /** This app's version. */
  installed: string;
  line(): ReleaseLine;
  /** What the home holds, as the daemon last said. */
  homeData(): HomeData | undefined;
  /** What the home holds now, asked of the daemon; undefined when it can't say. */
  freshHomeData(): Promise<HomeData | undefined>;
  feed: FeedPorts;
  /** Registers the download's progress listener (electron-updater's `download-progress`). */
  onProgress(listener: (percent: number) => void): void;
  checkTimeoutMs: number;
  squirrelVerdictMs: number;
  log(level: "info" | "warn", message: string): void;
}

/** The release the last successful check offered. */
interface Offer {
  version: string;
  feedUrl: string;
  older: boolean;
  line: ReleaseLine;
  data: ReleaseData | undefined;
}

export function feedEngine(ports: FeedEnginePorts): UpdateEngine {
  const { updater } = ports;
  let offered: Offer | undefined;
  /** The release downloaded and waiting to install, whatever later checks offer. */
  let downloaded: Offer | undefined;
  let progress: ((percent: number) => void) | undefined;
  ports.onProgress((percent) => progress?.(percent));

  /** Points electron-updater at `offer`'s folder; a downgrade only for a guarded switch. */
  const point = (offer: Pick<Offer, "feedUrl" | "older">) => {
    updater.setFeedURL({ provider: "generic", url: offer.feedUrl });
    updater.allowDowngrade = offer.older;
  };
  const read = () =>
    within(updater.checkForUpdates(), ports.checkTimeoutMs, "The update check timed out.");

  return {
    canInstall: ports.canInstall,
    async check() {
      const line = ports.line();
      // The packaged launch check waits for this line (`launch-verdict.ts`).
      ports.log("info", `updater: Checking for updates on the ${line} line`);
      // The person hears back even when the network hangs.
      const found = await within(
        checkReleaseFeed(ports.feed, { installed: ports.installed, line, home: ports.homeData() }),
        ports.checkTimeoutMs,
        "The update check timed out.",
      );
      if (found.kind !== "offer") {
        offered = undefined;
        return found.kind === "blocked" ? { blocked: found.message } : undefined;
      }
      point(found);
      const result = await read();
      if (!result?.isUpdateAvailable || result.updateInfo.version !== found.version) {
        offered = undefined;
        return undefined;
      }
      offered = {
        version: found.version,
        feedUrl: found.feedUrl,
        older: found.older,
        line,
        data: found.data,
      };
      return { version: found.version, releaseUrl: found.releaseUrl, ...noteGroups(found.notes) };
    },
    recheck() {
      // Both the offer about to download and the one already downloaded: a later check may
      // have moved the offer on while an older release still waits to install.
      const older = [offered, downloaded].filter((offer) => offer?.older === true);
      if (older.length === 0) return undefined;
      return (async () => {
        const home = await ports.freshHomeData().catch(() => undefined);
        for (const offer of older) {
          const guard = guardSwitch(offer?.data, home);
          if (!guard.ok)
            return {
              blocked: blockedSentence(
                guard.reason,
                releaseLineOf(ports.installed),
                offer?.line ?? ports.line(),
              ),
            };
        }
        return undefined;
      })();
    },
    discard() {
      offered = undefined;
      downloaded = undefined;
      updater.autoInstallOnAppQuit = false;
    },
    async download(report) {
      const offer = offered;
      if (!offer) throw new Error("Nothing is on offer; check for updates again.");
      // A check that timed out may have finished since and pointed the updater elsewhere.
      point(offer);
      let result = await read();
      if (result?.updateInfo.version !== offer.version) result = await read();
      if (result?.updateInfo.version !== offer.version)
        throw new Error("The release on offer changed; check for updates again.");
      // A switch to an older release installs only through the person's Restart, after the
      // guard runs again: never on quit, and Squirrel gets it only then (`quitAndInstall`).
      updater.autoInstallOnAppQuit = !offer.older;
      // Squirrel.Mac verifies the signature only after electron-updater's download resolves.
      const verdict =
        ports.squirrel && !offer.older
          ? squirrelVerdict(ports.squirrel, ports.squirrelVerdictMs)
          : undefined;
      progress = report;
      try {
        await updater.downloadUpdate();
        await verdict?.promise;
        downloaded = offer;
      } finally {
        progress = undefined;
        verdict?.dispose();
      }
    },
    install() {
      // Windows: silent, and start ace again afterwards. macOS and Linux ignore both.
      updater.quitAndInstall(true, true);
    },
  };
}

function squirrelVerdict(squirrel: SquirrelEvents, ms: number) {
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
      ms,
    );
    squirrel.once("update-downloaded", held.downloaded);
    squirrel.once("error", held.failed);
  });
  // Awaited only after the download; a refusal before then must not go unhandled.
  promise.catch(() => {});
  return { promise, dispose };
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
