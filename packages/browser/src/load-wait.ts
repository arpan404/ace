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
 * A request still open this long is a long poll or a stream (a dev server's reload channel, a
 * feed), not part of loading the page: it no longer keeps the network busy.
 */
export const lastingRequestMs = 5_000;

/**
 * Waits until the page has had no network request in flight for `networkQuietMs`. Sockets and
 * event streams never count, and a request open for `lastingRequestMs` stops counting, so a
 * dev server's reload socket or a long poll can't hold the wait until its timeout.
 */
export async function networkIdle(
  page: Pick<BrowserBackendPage, "networkPending">,
  clock: NavigationClock,
  signal: AbortSignal,
): Promise<void> {
  const pending = page.networkPending?.bind(page);
  if (!pending) throw new BrowserActionError("not_supported");
  /** When this wait first saw each request in flight. */
  const seen = new Map<string, number>();
  let quietSince: number | undefined = clock.now();
  for (;;) {
    signal.throwIfAborted();
    const now = clock.now();
    const open = new Set(pending());
    for (const id of seen.keys()) if (!open.has(id)) seen.delete(id);
    let busy = false;
    for (const id of open) {
      const since = seen.get(id) ?? now;
      seen.set(id, since);
      if (now - since < lastingRequestMs) busy = true;
    }
    // Quiet counts from the first look that finds nothing in flight, never from the last busy
    // one: the requests may have ended any time up to this look.
    if (busy) quietSince = undefined;
    else if (quietSince === undefined) quietSince = now;
    else if (now - quietSince >= networkQuietMs) return;
    await pause(clock, pollMs, signal);
  }
}
