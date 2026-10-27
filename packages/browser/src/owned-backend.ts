import { basename, dirname, join } from "node:path";
import type { BrowserDownloadProgress } from "@ace/protocol";
import { acquireChromium } from "./acquisition.ts";
import { installedWindowsChromium } from "./discovery.ts";
import { chromiumProcessKiller } from "./chromium-process.ts";
import type { Schedule } from "./cdp-connection.ts";
import type { ChromeCleanup, ChromeLaunch } from "./chrome-instance.ts";
import { ChromeBackend } from "./headless.ts";
import { spawnProcess } from "./io.ts";
import { guardChromium } from "./process-guardian.ts";
import { linuxLaunchDiagnosis, smallSharedMemory } from "./launch-diagnosis.ts";
import type { BrowserServiceOptions } from "./service-options.ts";

const schedule: Schedule = (work, milliseconds) => {
  const timer = setTimeout(work, milliseconds);
  // Deadlines never keep the daemon alive on their own; the browser's pipes do while it runs.
  timer.unref();
  return () => clearTimeout(timer);
};
/**
 * Defaults for ace's own Chrome. Retina-class output is the default device scale (ADR 0083).
 * Without its sandbox only when the person opted in (`ACE_CHROMIUM_NO_SANDBOX`), never as a
 * fallback.
 */
export function chromeDefaults(
  platform: NodeJS.Platform,
  sandbox = true,
  /** Windows: where a Chrome tree that outlived its browser is reported. */
  report?: (error: Error) => void,
): {
  launch: ChromeLaunch;
  cleanup: ChromeCleanup;
} {
  const jobs = platform === "win32" ? windowsJobs(report) : undefined;
  return {
    launch: {
      args: [
        ...(sandbox ? [] : ["--no-sandbox"]),
        ...(platform === "linux" && smallSharedMemory() ? ["--disable-dev-shm-usage"] : []),
        // Windows: started elevated (an administrator's desktop, UAC off), Chrome and Edge
        // relaunch themselves unelevated through the shell and the relaunched browser never
        // gets ace's debugging pipe ("Remote debugging pipe file descriptors are not open").
        ...(platform === "win32" ? ["--do-not-de-elevate"] : []),
      ],
      ...(platform === "linux" ? { diagnose: linuxLaunchDiagnosis() } : {}),
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
      // Windows: a kill-on-close job owns each profile's Chrome tree instead.
      ...(jobs && jobs.launch),
    },
    cleanup: {
      timeoutMs: 5_000,
      schedule,
      kill: chromiumProcessKiller(platform),
      ...(jobs && { kill: jobs.kill }),
    },
  };
}

/**
 * Windows: the required job containment (`chrome-job.ts`), loaded with the first launch so
 * other platforms never load it. Every launch's `guard` runs before its `spawn`.
 */
function windowsJobs(report?: (error: Error) => void) {
  let jobs: ReturnType<typeof import("./chrome-job.ts").chromeJobs> | undefined;
  let emulated: typeof import("./emulated-chrome.ts").emulatedChromeArgs | undefined;
  const ready = () => {
    if (!jobs) throw new Error("ace's Chrome containment is not loaded on Windows");
    return jobs;
  };
  return {
    launch: {
      guard: async (profile: string) => {
        jobs ??= (await import("./chrome-job.ts")).chromeJobs({
          spawn: spawnProcess,
          ...(report && { report }),
        });
        emulated ??= (await import("./emulated-chrome.ts")).emulatedChromeArgs;
        return jobs.guard(profile);
      },
      // Each executable gets its own flags: an emulated x64 Chrome on ARM64 is not native.
      spawn: ((command, args, options) =>
        ready().spawn(
          command,
          emulated ? emulated(command, args, process.arch) : args,
          options,
        )) satisfies ChromeLaunch["spawn"],
    },
    kill: (pid: number) => ready().kill(pid),
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
  const defaults =
    process.platform === "win32"
      ? chromeDefaults(process.platform, options.sandbox !== false, (error) =>
          options.onError?.(error),
        )
      : chromeDefaults(process.platform, options.sandbox !== false);
  const launch: ChromeLaunch = { ...defaults.launch, ...options.chrome };
  launch.args = [...defaults.launch.args, ...(options.chrome?.args ?? [])];
  const diagnose = launch.diagnose;
  // A browser that will not start is the person's to fix: the daemon log keeps the cause.
  launch.diagnose = async (failure) => {
    const error = diagnose ? await diagnose(failure).catch(() => failure.error) : failure.error;
    options.onError?.(error);
    return error;
  };
  let owned: ChromeBackend | undefined;
  const backend =
    options.headlessBackend ??
    (owned = new ChromeBackend({
      executable: () => {
        if (options.executablePath) return Promise.resolve(options.executablePath);
        // Chrome for Testing has no Windows ARM64 build: use the installed Chrome or Edge, and
        // without one that ace can drive, the x64 build under Windows' emulation.
        if (
          process.platform === "win32" &&
          process.arch === "arm64" &&
          !options.acquisition?.artifact
        )
          acquiring ??= installedWindowsChromium({ dataDir: options.dataDir })
            .catch(() =>
              // Run under emulation, with the flags `emulated-chrome.ts` gives it at launch.
              import("./chromium-manifest.ts").then(({ chromiumArtifact }) =>
                acquireChromium({
                  ...options.acquisition,
                  artifact: chromiumArtifact("win32", "x64"),
                  dataDir: options.dataDir,
                  signal,
                  progress,
                }),
              ),
            )
            .catch((error: unknown) => {
              acquiring = undefined;
              options.onError?.(error);
              throw error;
            });
        acquiring ??= acquireChromium({
          ...options.acquisition,
          dataDir: options.dataDir,
          signal,
          progress,
        }).catch((error: unknown) => {
          acquiring = undefined;
          options.onError?.(error);
          throw error;
        });
        return acquiring;
      },
      stagingDir: (profileDir) => join(dirname(profileDir), `${basename(profileDir)}-downloads`),
      platform: process.platform,
      launch,
      cleanup: { ...defaults.cleanup, ...options.cleanup },
      encoder: {
        profileDir: join(options.dataDir, "browser", "encoder"),
        idleMs: options.videoEncoderIdleMs ?? 30_000,
      },
      // Windows without a usable GPU draws ace's Chrome at device scale 1 (`gpu-scale.ts`),
      // unless the embedder chose a scale.
      ...(process.platform === "win32" &&
        options.chrome?.deviceScaleFactor === undefined && {
          windowsScale: async (gpu: unknown) =>
            (await import("./gpu-scale.ts")).windowsDeviceScale(gpu, launch.deviceScaleFactor),
        }),
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
