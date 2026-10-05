import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

const Result = z.object({
  frameId: z.string().optional(),
  loaderId: z.string().optional(),
  errorText: z.string().optional(),
});
const Lifecycle = z.object({ loaderId: z.string(), name: z.string() });
/** Daemon-owned navigation bypasses the native view's independent load timer.
 * The session owns the deadline and aborts approval work when loading stops. */
export async function navigateCdp(
  cdp: BrowserCdp,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
  signal?.throwIfAborted();
  const ready = new Set<string>();
  let loader: string | undefined;
  const { promise: completed, resolve: accept, reject } = Promise.withResolvers<void>();
  const lifecycle = (raw: unknown) => {
    const event = Lifecycle.safeParse(raw);
    if (!event.success || event.data.name !== "DOMContentLoaded") return;
    if (ready.size >= 64) ready.clear();
    ready.add(event.data.loaderId);
    if (loader === event.data.loaderId) accept();
  };
  const abort = () => reject(signal?.reason ?? new Error("Browser navigation cancelled"));
  cdp.on("Page.lifecycleEvent", lifecycle);
  signal?.addEventListener("abort", abort, { once: true });
  // Attach a rejection handler before Page.navigate, which itself can await Fetch.
  const response = Promise.resolve()
    .then(() => {
      signal?.throwIfAborted();
      return cdp.send("Page.navigate", { url });
    })
    .then((raw) => {
      const result = Result.parse(raw);
      if (result.errorText) throw new Error(result.errorText);
      loader = result.loaderId;
      if (!loader || ready.has(loader)) accept();
    })
    .catch(reject);
  if (signal?.aborted) abort();
  try {
    await completed;
  } finally {
    signal?.removeEventListener("abort", abort);
    cdp.off("Page.lifecycleEvent", lifecycle);
    // The transport owns its bounded request; a late reply is never replayed.
    void response;
  }
}
