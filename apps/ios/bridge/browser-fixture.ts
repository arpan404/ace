// The native host stand-in loads before any bridge module reads it (the upload tray does).
export { native as nativeHost } from "./test-host.ts";
import { BrowserPageMessage, type ServerMessage } from "@ace/protocol";
import { BrowserLive, type BrowserOwner, type BrowserThreadContext } from "./browser-live.ts";
import { plainPreview, RecordingSink, sheetFixture } from "./sheet-fixture.ts";
import type { ChunkReader } from "./thread-attachments.ts";

/*
 * The live browser view on a real client and the fake daemon, for the bridge's browser tests:
 * the thread `web` in project `ace`, with a browser on a cart page unless asked not to.
 */

const closers: (() => Promise<void>)[] = [];
/** Close every view and client the tests opened (call from `afterEach`). */
export async function closeBrowserFixtures(): Promise<void> {
  await Promise.all(closers.splice(0).map((close) => close()));
}

export const viewport = { width: 390, height: 700, devicePixelRatio: 3 };

/** A real client on the fake daemon; `push` delivers a message the fixture doesn't produce. */
export async function liveBrowser(
  options: { browser?: boolean; read?: ChunkReader; names?: Record<string, string> } = {},
) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({ id: "web", workspaceId: "ace", title: "Checkout", provider: "codex" });
  if (options.browser !== false) daemon.browser.drive("web", { url: "https://shop.test/cart" });
  await client.start();
  const listeners = new Set<(message: ServerMessage) => void>();
  const sent: unknown[] = [];
  const requested: unknown[] = [];
  const owner: BrowserOwner = {
    request: (message, requestOptions) => {
      requested.push(message);
      return client.request(message, requestOptions);
    },
    send: (message) => {
      sent.push(message);
      client.send(message);
    },
    onMessage: (listener) => {
      listeners.add(listener);
      const stop = client.onMessage(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    get state() {
      return client.state;
    },
    connectionState: () => client.connectionState(),
  };
  const sink = new RecordingSink();
  const scheduled: (() => void)[] = [];
  let now = 1_000;
  const context: BrowserThreadContext = {
    agentName: (_threadId, agentId) => (agentId && options.names?.[agentId]) || "An agent",
    workspaceId: (threadId) => (threadId === "web" ? "ace" : undefined),
    now: () => ++now,
    read: options.read ?? (() => Promise.reject(new Error("no files in this test"))),
  };
  const view = new BrowserLive(
    owner,
    sink,
    plainPreview,
    (_delay, callback) => {
      scheduled.push(callback);
      return () => {
        const index = scheduled.indexOf(callback);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    context,
  );
  closers.push(async () => view.dispose());
  /** A page state report, as the daemon sends it (the fixture has none of its own). */
  const push = (message: unknown) => {
    const page = BrowserPageMessage.parse(message);
    for (const listener of listeners) listener(page);
  };
  return { daemon, sink, view, sent, requested, push, scheduled };
}
