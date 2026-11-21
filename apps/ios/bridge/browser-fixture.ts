// The native host stand-in loads before any bridge module reads it (the upload tray does).
export { native as nativeHost } from "./test-host.ts";
import { ClientError } from "@ace/client";
import { BrowserPageMessage, type ServerMessage } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
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
/** Why the daemon couldn't serve a view (`media: "unserved"`). */
export const unservedReason = {
  code: "restarting",
  reason: "Live video is starting. It shows in a moment.",
};

/** A real client on the fake daemon; `push` delivers a message the fixture doesn't produce. */
export async function liveBrowser(
  options: {
    browser?: boolean;
    read?: ChunkReader;
    names?: Record<string, string>;
    /**
     * How the daemon answers a subscribe naming a media connection (ADR 0147 §4): `binds` says
     * so in its reply, `refuses` refuses it as another session's, `unserved` answers without
     * `media`, saying why (ace-media can't serve it yet), and by default it answers as the fake
     * daemon does, without `media`. `hangs`: its request waits until the test fails it
     * (`hanging`), as a lost connection would. `fails`: its request fails at once.
     */
    media?: "binds" | "refuses" | "unserved" | "hangs" | "fails";
    devices?: { storage: KeyValueStorage; ready: Promise<void> };
    context?: Pick<
      BrowserThreadContext,
      "files" | "stage" | "annotations" | "threadState" | "observeThreads"
    >;
  } = {},
) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({ id: "web", workspaceId: "ace", title: "Checkout", provider: "codex" });
  if (options.browser !== false) daemon.browser.drive("web", { url: "https://shop.test/cart" });
  await client.start();
  const listeners = new Set<(message: ServerMessage) => void>();
  const sent: unknown[] = [];
  const requested: unknown[] = [];
  /** Subscribes left waiting (`media: "hangs"`): each fails its request when called. */
  const hanging: ((error: Error) => void)[] = [];
  const owner: BrowserOwner = {
    request: ((message, requestOptions) => {
      requested.push(message);
      const named = message.type === "browser.subscribe" ? message.media : undefined;
      if (named && options.media === "refuses")
        return Promise.resolve({
          type: "browser.result",
          requestId: "refused",
          ok: false,
          error: "media-connection: that media connection isn't this session's",
        });
      if (named && options.media === "fails") return Promise.reject(new ClientError("timeout"));
      if (named && options.media === "hangs")
        return new Promise((_resolve, reject) => void hanging.push(reject));
      const reply = client.request(message, requestOptions);
      if (named && options.media === "unserved")
        return reply.then((value) => ({ ...value, undelivered: unservedReason }));
      if (!named || options.media !== "binds") return reply;
      // Served: its reply names the connection and says nothing is missing.
      return reply.then((value) => {
        const served = { ...value, media: { connection: named.connection } };
        Reflect.deleteProperty(served, "undelivered");
        return served;
      });
      // The fake daemon's own replies, changed only where a test asked for a media answer.
    }) as BrowserOwner["request"],
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
    onStream: (listener) => client.onStream(listener),
  };
  const sink = new RecordingSink();
  const scheduled: (() => void)[] = [];
  /** Each scheduled callback's delay, for a test to run only the timers it means. */
  const delays = new Map<() => void, number>();
  let now = 1_000;
  const context: BrowserThreadContext = {
    agentName: (_threadId, agentId) => (agentId && options.names?.[agentId]) || "An agent",
    workspaceId: (threadId) => (threadId === "web" ? "ace" : undefined),
    now: () => ++now,
    read: options.read ?? (() => Promise.reject(new Error("no files in this test"))),
    ...(options.devices ? { devices: options.devices } : {}),
    ...options.context,
  };
  const view = new BrowserLive(
    owner,
    sink,
    plainPreview,
    (delay, callback) => {
      scheduled.push(callback);
      delays.set(callback, delay);
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
  /** A message from the daemon the fixture doesn't produce (`browser.delivery`, say). */
  const announce = (message: ServerMessage) => {
    for (const listener of listeners) listener(message);
  };
  /** Runs the scheduled callbacks of `delay` ms, as if that long passed for them alone. */
  const elapse = (delay: number) => {
    for (const run of scheduled.filter((callback) => delays.get(callback) === delay)) {
      scheduled.splice(scheduled.indexOf(run), 1);
      run();
    }
  };
  return {
    daemon,
    client,
    sink,
    view,
    sent,
    requested,
    push,
    announce,
    scheduled,
    hanging,
    elapse,
  };
}
