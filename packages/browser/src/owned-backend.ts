import { basename, dirname, join } from "node:path";
import type { BrowserDownloadProgress } from "@ace/protocol";
import { acquireChromium } from "./acquisition.ts";
import { chromiumProcessKiller } from "./chromium-process.ts";
import type { Schedule } from "./cdp-connection.ts";
import type { ChromeCleanup, ChromeLaunch } from "./chrome-instance.ts";
import { ChromeBackend } from "./headless.ts";
import { spawnProcess } from "./io.ts";
import { guardChromium } from "./process-guardian.ts";
import type { BrowserServiceOptions } from "./service-options.ts";

const schedule: Schedule = (work, milliseconds) => {
  const timer = setTimeout(work, milliseconds);
  // Deadlines never keep the daemon alive on their own; the browser's pipes do while it runs.
  timer.unref();
  return () => clearTimeout(timer);
};
/** Defaults for ace's own Chrome. Retina-class output is the default device scale (ADR 0083). */
export function chromeDefaults(platform: NodeJS.Platform): {
  launch: ChromeLaunch;
  cleanup: ChromeCleanup;
} {
  return {
    launch: {
      args: [],
      deviceScaleFactor: 2,
      idleMs: 10 * 60_000,
      startTimeoutMs: 30_000,
      commandTimeoutMs: 60_000,
      spawn: spawnProcess,
      // The guardian matches processes by command line; Windows has no `ps` and no process groups.
      guard:
        platform === "win32"
          ? async () => ({ close: async () => {} })
          : (profile) => guardChromium(profile),
    },
    cleanup: { timeoutMs: 5_000, schedule, kill: chromiumProcessKiller(platform) },
  };
}

/** First-use acquisition stays in the I/O boundary and shares the service lifetime. */
export function ownedHeadless(options: BrowserServiceOptions, signal: AbortSignal) {
  let acquiring: Promise<string> | undefined;
  const listeners = new Set<(value: BrowserDownloadProgress) => void>();
  const progress = (value: BrowserDownloadProgress) => {
    options.onDownload?.(value);
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };
  const defaults = chromeDefaults(process.platform);
  let owned: ChromeBackend | undefined;
  const backend =
    options.headlessBackend ??
    (owned = new ChromeBackend({
      executable: () => {
        if (options.executablePath) return Promise.resolve(options.executablePath);
        acquiring ??= acquireChromium({
          ...options.acquisition,
          dataDir: options.dataDir,
          signal,
          progress,
        }).catch((error) => {
          acquiring = undefined;
          throw error;
        });
        return acquiring;
      },
      stagingDir: (profileDir) => join(dirname(profileDir), `${basename(profileDir)}-downloads`),
      platform: process.platform,
      launch: { ...defaults.launch, ...options.chrome },
      cleanup: { ...defaults.cleanup, ...options.cleanup },
      encoder: {
        profileDir: join(options.dataDir, "browser", "encoder"),
        idleMs: options.videoEncoderIdleMs ?? 30_000,
      },
    }));
  return {
    backend,
    /** Video for a backend without an encoder of its own ("Use my Chrome"). */
    videoEncoder: () => owned?.encoder(),
    subscribe: (listener: (value: BrowserDownloadProgress) => void) => {
      if (listeners.size >= 64) throw new Error("Browser download subscriber limit");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled: async () => {
      listeners.clear();
      if (acquiring) await Promise.allSettled([acquiring]);
    },
    /** Stops ace's browsers; called after every session has closed. */
    close: async () => {
      await owned?.close();
    },
  };
}
