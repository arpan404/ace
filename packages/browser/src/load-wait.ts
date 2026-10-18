import { z } from "zod";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserBackendPage } from "./backend.ts";
import type { NavigationClock } from "./navigation.ts";

/** How long the network must stay quiet to count as idle, as Chromium's own networkIdle. */
export const networkQuietMs = 500;
const pollMs = 50;

const ReadyState = z.object({ result: z.object({ value: z.unknown() }) });

/** A client redirect replaced the document mid-read: read the new one on the next poll. */
function replacedDocument(error: unknown): undefined {
  if (
    error instanceof Error &&
    /Execution context was destroyed|Cannot find context|Inspected target navigated/.test(
      error.message,
    )
  )
    return undefined;
  throw error;
}

/** Resolves after `ms` on the injected clock, or rejects when `signal` aborts. */
export function pause(clock: NavigationClock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      cancel();
      reject(signal.reason);
    };
    const cancel = clock.set(ms, () => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Waits until the page's document has loaded with its subresources (the load event). */
export async function documentLoaded(
  page: BrowserBackendPage,
  clock: NavigationClock,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const state = await page.cdp
      .send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true })
      .then((raw) => ReadyState.parse(raw).result.value, replacedDocument);
    if (state === "complete") return;
    await pause(clock, pollMs, signal);
  }
}

/**
 * Waits until the page has had no network request in flight for `networkQuietMs`. Long-polling
 * or streaming pages never get there; their wait ends at its timeout.
 */
export async function networkIdle(
  page: BrowserBackendPage,
  clock: NavigationClock,
  signal: AbortSignal,
): Promise<void> {
  const pending = page.networkPending?.bind(page);
  if (!pending) throw new BrowserActionError("not_supported");
  let quietSince = clock.now();
  for (;;) {
    signal.throwIfAborted();
    if (pending() > 0) quietSince = clock.now();
    else if (clock.now() - quietSince >= networkQuietMs) return;
    await pause(clock, pollMs, signal);
  }
}
