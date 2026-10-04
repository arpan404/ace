import { chromiumProcessKiller } from "./chromium-process.ts";
import type { BrowserContext } from "playwright-core";
import { z } from "zod";

export interface ChromiumCleanupRuntime {
  timeoutMs: number;
  probeTimeoutMs: number;
  schedule(expire: () => void, milliseconds: number): () => void;
  kill(pid: number): void | Promise<void>;
  onTimeout?(message: string): void;
}
const systemCleanup: ChromiumCleanupRuntime = {
  timeoutMs: 5_000,
  probeTimeoutMs: 2_000,
  schedule(expire, milliseconds) {
    const timer = setTimeout(expire, milliseconds);
    return () => clearTimeout(timer);
  },
  kill: chromiumProcessKiller(process.platform),
};
const ProcessInfo = z.object({
  processInfo: z.array(z.object({ type: z.string(), id: z.number().int().positive() })).max(4096),
});

/** Own teardown immediately, before any asynchronous identity discovery. */
export function chromiumCloser(
  context: BrowserContext,
  overrides: Partial<ChromiumCleanupRuntime> = {},
) {
  const runtime = { ...systemCleanup, ...overrides };
  const browser = context.browser();
  let pid: number | undefined;
  let closing: Promise<void> | undefined;
  const report = (message: string) => {
    try {
      runtime.onTimeout?.(message);
    } catch {
      /* Observers cannot fail teardown. */
    }
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      let cancel: (() => void) | undefined;
      const forced = new Promise<void>((resolve) => {
        cancel = runtime.schedule(() => {
          void (async () => {
            try {
              if (pid !== undefined && browser?.isConnected()) await runtime.kill(pid);
              report(
                `Chromium cleanup exceeded ${runtime.timeoutMs}ms; ${pid === undefined ? "process identity unavailable" : "force-killed browser"}`,
              );
            } catch (error) {
              report(
                `Chromium cleanup exceeded ${runtime.timeoutMs}ms; termination failed: ${String(error)}`,
              );
            } finally {
              void browser?.close({ reason: "Chromium cleanup deadline" }).catch(() => {});
              resolve();
            }
          })();
        }, runtime.timeoutMs);
      });
      try {
        await Promise.race([Promise.resolve().then(() => context.close()), forced]);
      } finally {
        cancel?.();
      }
    })();
    return closing;
  };
  const ready = async (signal: AbortSignal): Promise<void> => {
    for (const milliseconds of [runtime.timeoutMs, runtime.probeTimeoutMs])
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 1)
        throw new Error("Invalid Chromium cleanup deadline");
    signal.throwIfAborted();
    let cancel: (() => void) | undefined;
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(new Error("Chromium process identity cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    cancel = runtime.schedule(
      () => aborted.reject(new Error("Chromium process identity deadline exceeded")),
      runtime.probeTimeoutMs,
    );
    const probe = async () => {
      if (!browser) throw new Error("Chromium process unavailable");
      const cdp = await browser.newBrowserCDPSession();
      try {
        signal.throwIfAborted();
        const data: unknown = await cdp.send("SystemInfo.getProcessInfo");
        pid = ProcessInfo.parse(data).processInfo.find((info) => info.type === "browser")?.id;
        if (pid === undefined) throw new Error("Chromium process identity unavailable");
      } finally {
        void cdp.detach().catch(() => {});
      }
    };
    try {
      await Promise.race([probe(), aborted.promise]);
    } finally {
      cancel?.();
      signal.removeEventListener("abort", abort);
    }
  };
  return { ready, close };
}
