import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { BrowserActionError } from "./action-error.ts";

const Result = z.object({
  frameId: z.string().optional(),
  loaderId: z.string().optional(),
  errorText: z.string().optional(),
});
const Lifecycle = z.object({ loaderId: z.string(), name: z.string() });
const Committed = z.object({
  frame: z.object({ id: z.string(), loaderId: z.string(), parentId: z.string().optional() }),
});
const Loading = z.object({ frameId: z.string() });
/** Chromium's code for a navigation that was cancelled rather than refused. */
const aborted = "net::ERR_ABORTED";
const remembered = 64;

/**
 * Navigate the page and wait until the document it led to is ready (DOMContentLoaded).
 *
 * The navigation succeeds once the tab commits a document for it, or for a navigation that
 * replaced it after it started: the page re-navigating itself before its DOM was ready
 * (`location.replace`, a client redirect) or a later navigation of the same view. An
 * `ERR_ABORTED` reply only means another navigation took over; it fails only when the page then
 * stops loading with nothing new committed (Stop, a 204, a download). Any other error text
 * (DNS, refused connection) fails at once.
 *
 * Daemon-owned navigation bypasses the native view's independent load timer. The session owns
 * the deadline and aborts approval work when loading stops.
 */
export async function navigateCdp(
  cdp: BrowserCdp,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
  signal?.throwIfAborted();
  const ready = new Set<string>();
  /** Main-frame documents committed since this navigation was sent, oldest first. */
  const commits: string[] = [];
  const stopped = new Set<string>();
  let reply: z.infer<typeof Result> | undefined;
  const { promise: completed, resolve: accept, reject } = Promise.withResolvers<void>();
  const settle = () => {
    if (!reply) return;
    const { loaderId, frameId, errorText } = reply;
    if (errorText && errorText !== aborted) return reject(new Error(errorText));
    // No loader: a same-document navigation, which fires no DOMContentLoaded.
    if (!errorText && (!loaderId || ready.has(loaderId))) return accept();
    // This navigation's document, or any committed after it (the page replaced it).
    const from = errorText ? 0 : commits.indexOf(loaderId ?? "");
    if (from >= 0 && commits.slice(from).some((loader) => ready.has(loader))) return accept();
    if (errorText && commits.length === 0 && frameId !== undefined && stopped.has(frameId))
      reject(new Error(errorText));
  };
  const lifecycle = (raw: unknown) => {
    const event = Lifecycle.safeParse(raw);
    if (!event.success || event.data.name !== "DOMContentLoaded") return;
    if (ready.size >= remembered) ready.clear();
    ready.add(event.data.loaderId);
    settle();
  };
  const committed = (raw: unknown) => {
    const event = Committed.safeParse(raw);
    if (!event.success || event.data.frame.parentId !== undefined) return;
    if (commits.length >= remembered) commits.shift();
    commits.push(event.data.frame.loaderId);
    stopped.delete(event.data.frame.id);
    settle();
  };
  const started = (raw: unknown) => {
    const event = Loading.safeParse(raw);
    if (event.success) stopped.delete(event.data.frameId);
  };
  const stoppedLoading = (raw: unknown) => {
    const event = Loading.safeParse(raw);
    if (!event.success) return;
    stopped.add(event.data.frameId);
    settle();
  };
  const abort = () => reject(signal?.reason ?? new Error("Browser navigation cancelled"));
  // The desktop's view kept a page whose unsaved changes are the person's (`will-prevent-unload`).
  const refused = () => reject(new BrowserActionError("unsaved_changes"));
  cdp.on("ace.unloadRefused", refused);
  cdp.on("Page.lifecycleEvent", lifecycle);
  cdp.on("Page.frameNavigated", committed);
  cdp.on("Page.frameStartedLoading", started);
  cdp.on("Page.frameStoppedLoading", stoppedLoading);
  signal?.addEventListener("abort", abort, { once: true });
  // Attach a rejection handler before Page.navigate, which itself can await Fetch.
  const response = Promise.resolve()
    .then(() => {
      signal?.throwIfAborted();
      return cdp.send("Page.navigate", { url });
    })
    .then((raw) => {
      reply = Result.parse(raw);
      settle();
    })
    .catch(reject);
  if (signal?.aborted) abort();
  try {
    await completed;
  } finally {
    signal?.removeEventListener("abort", abort);
    cdp.off("ace.unloadRefused", refused);
    cdp.off("Page.lifecycleEvent", lifecycle);
    cdp.off("Page.frameNavigated", committed);
    cdp.off("Page.frameStartedLoading", started);
    cdp.off("Page.frameStoppedLoading", stoppedLoading);
    // The transport owns its bounded request; a late reply is never replayed.
    void response;
  }
}
