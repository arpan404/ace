import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserBackend, BackendOpen } from "./backend.ts";
import type { BrowserSession } from "./session.ts";

/** A fresh ephemeral page; only its URL and daemon-owned controller lease survive. */
export async function recoverHeadless(options: {
  request: BackendOpen;
  backend: BrowserBackend;
  session: BrowserSession;
  root: string;
  url: string;
  profileCreated(path: string): void;
  lost(reason: string): void;
}): Promise<void> {
  const { request, backend, session, root, url } = options;
  const profileDir = await mkdtemp(join(root, "recovery-"));
  options.profileCreated(profileDir);
  request.signal.throwIfAborted();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([request.signal, lifetime.signal]);
  const replacement = await backend.open({
    ...request,
    options: { ...request.options, profile: "ephemeral", headed: false },
    profileDir,
    signal,
    lost: (reason) => {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new Error(reason));
      options.lost(reason);
    },
  });
  try {
    signal.throwIfAborted();
    replacement.privateMode?.(session.state.takeoverMode === "private");
    if (url !== "about:blank") {
      if (!(await request.allowed(url)))
        throw new Error("Browser recovery origin requires approval");
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
