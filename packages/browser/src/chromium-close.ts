import { execFileSync } from "node:child_process";
import type { BrowserContext } from "playwright-core";
import { z } from "zod";

export interface ChromiumCleanupRuntime {
  timeoutMs: number;
  schedule(expire: () => void, milliseconds: number): () => void;
  kill(pid: number): void;
  onTimeout?(message: string): void;
}
const systemCleanup: ChromiumCleanupRuntime = {
  timeoutMs: 5_000,
  schedule(expire, milliseconds) {
    const timer = setTimeout(expire, milliseconds);
    return () => clearTimeout(timer);
  },
  kill(pid) {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        timeout: 1000,
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  },
};
const ProcessInfo = z.object({
  processInfo: z.array(z.object({ type: z.string(), id: z.number().int().positive() })).max(4096),
});

/** Capture the owned process identity while CDP is live, before a stalled close. */
export async function chromiumCloser(
  context: BrowserContext,
  overrides: Partial<ChromiumCleanupRuntime> = {},
) {
  const runtime = { ...systemCleanup, ...overrides };
  if (!Number.isSafeInteger(runtime.timeoutMs) || runtime.timeoutMs < 1)
    throw new Error("Invalid Chromium cleanup deadline");
  const browser = context.browser();
  if (!browser) throw new Error("Chromium process unavailable");
  const cdp = await browser.newBrowserCDPSession();
  let pid: number | undefined;
  try {
    const data: unknown = await cdp.send("SystemInfo.getProcessInfo");
    pid = ProcessInfo.parse(data).processInfo.find((info) => info.type === "browser")?.id;
  } finally {
    await cdp.detach();
  }
  if (pid === undefined) throw new Error("Chromium process identity unavailable");
  const ownedPid = pid;
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      let cancel: (() => void) | undefined;
      const forced = new Promise<void>((resolve, reject) => {
        cancel = runtime.schedule(() => {
          try {
            if (browser.isConnected()) runtime.kill(ownedPid);
            // Dispose the Playwright connection too, so pending CDP calls settle.
            void browser.close({ reason: "Chromium cleanup deadline" }).catch(() => {});
            try {
              runtime.onTimeout?.(
                `Chromium cleanup exceeded ${runtime.timeoutMs}ms; force-killed browser`,
              );
            } catch {
              /* Observers cannot turn a forced cleanup into a failure. */
            }
            resolve();
          } catch (error) {
            reject(error);
          }
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
}
