import { HeadlessBackend } from "./headless.ts";
import { acquireChromium } from "./acquisition.ts";
import type { BrowserServiceOptions } from "./service-options.ts";
import type { BrowserDownloadProgress } from "@ace/protocol";

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
  const backend =
    options.headlessBackend ??
    new HeadlessBackend(
      () => {
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
      options.launchContext,
      options.cleanup,
    );
  return {
    backend,
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
  };
}
