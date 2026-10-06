import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BackendConnection } from "../../desktop/src/main/browser/connection.ts";
import { BrowserBackend } from "../../desktop/src/main/browser/backend.ts";
import { readDesktopCredential } from "../../desktop/src/main/browser/credential.ts";
import { fakeViews } from "../../desktop/src/main/browser/test-support.ts";
import { startDaemon } from "./index.ts";
import { readConfig } from "./config.ts";
import { createDevThread } from "./commands.ts";

it("auto opens a native desktop page while background opens remain headless", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-native-selection-"));
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    browser: { executablePath: "/unavailable/headless" },
  });
  const views = fakeViews();
  const connection = new BackendConnection(new BrowserBackend(views.host, { log() {} }), {
    daemon: async () => ({ url: daemon.url, token: await readFile(daemon.tokenPath, "utf8") }),
    credential: () => readDesktopCredential(home),
    socket: (url) => new WebSocket(url),
    timers: {
      set(delay, work) {
        const timer = setTimeout(work, delay);
        return () => clearTimeout(timer);
      },
    },
    id: randomUUID,
    log() {},
  });
  try {
    connection.setAvailable(true);
    await vi.waitFor(() => expect(connection.state()).toBe("registered"));
    const workspaceId = daemon.store.createWorkspace(home, "Test");
    const thread = createDevThread(daemon.store, workspaceId);
    const state = await daemon.browser.open({ threadId: thread.id, workspaceId });
    expect(state.backend).toBe("embedded");
    expect(views.only().closed).toBe(false);
    await daemon.browser.closeThread(thread.id);
    await expect(
      daemon.browser.open({ threadId: thread.id, workspaceId, background: true }),
    ).rejects.toThrow();
  } finally {
    await daemon.close();
    connection.close();
    await rm(home, { recursive: true, force: true });
  }
});
