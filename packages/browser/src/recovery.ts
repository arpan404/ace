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
}): Promise<void> {
  const { request, backend, session, root, url } = options;
  const profileDir = await mkdtemp(join(root, "recovery-"));
  options.profileCreated(profileDir);
  request.signal.throwIfAborted();
  const replacement = await backend.open({
    ...request,
    options: { ...request.options, profile: "ephemeral", headed: false },
    profileDir,
    lost: (reason) => session.suspend(reason),
  });
  try {
    if (url !== "about:blank") {
      if (!(await request.allowed(url)))
        throw new Error("Browser recovery origin requires approval");
      request.signal.throwIfAborted();
      await replacement.navigate(url, 10_000);
    }
    request.signal.throwIfAborted();
    await session.replace(replacement);
  } catch (error) {
    await replacement.close().catch(() => {});
    throw error;
  }
}
