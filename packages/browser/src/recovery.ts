import type { BrowserBackend, BackendOpen } from "./backend.ts";
import type { BrowserSession } from "./session.ts";

/** A fresh private page in ace's browser; only its URL and the tab's privacy survive. */
export async function recoverHeadless(options: {
  request: BackendOpen;
  backend: BrowserBackend;
  session: BrowserSession;
  url: string;
  lost(reason: string): void;
}): Promise<void> {
  const { request, backend, session, url } = options;
  request.signal.throwIfAborted();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([request.signal, lifetime.signal]);
  const replacement = await backend.open({
    ...request,
    options: { ...request.options, profile: "ephemeral", headed: false },
    signal,
    lost: (reason) => {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new Error(reason));
      options.lost(reason);
    },
  });
  try {
    signal.throwIfAborted();
    replacement.privateMode?.(session.viewedPrivate);
    if (url !== "about:blank") {
      if (!(await request.allowed(url))) throw new Error("Browser recovery origin refused");
      signal.throwIfAborted();
      await replacement.navigate(url, 10_000);
    }
    signal.throwIfAborted();
    await session.replace(replacement, "headless", signal);
    signal.throwIfAborted();
  } catch (error) {
    await replacement.close().catch(() => {});
    throw error;
  }
}
