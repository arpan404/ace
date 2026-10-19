import { afterEach, describe, expect, test } from "vitest";
import { BrowserPageMessage, type ServerMessage } from "@ace/protocol";
import { BrowserLive, type BrowserOwner } from "./browser-live.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const viewport = { width: 390, height: 700, devicePixelRatio: 3 };

/** A real client on the fake daemon; `push` delivers a message the fixture doesn't produce. */
async function live(options: { browser?: boolean } = {}) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({ id: "web", workspaceId: "ace", title: "Checkout", provider: "codex" });
  if (options.browser !== false) daemon.browser.drive("web", { url: "https://shop.test/cart" });
  await client.start();
  const listeners = new Set<(message: ServerMessage) => void>();
  const sent: unknown[] = [];
  const owner: BrowserOwner = {
    request: client.request.bind(client),
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
  const view = new BrowserLive(owner, sink, plainPreview, (_delay, callback) => {
    scheduled.push(callback);
    return () => {
      const index = scheduled.indexOf(callback);
      if (index >= 0) scheduled.splice(index, 1);
    };
  });
  closers.push(async () => view.dispose());
  /** A page state report, as the daemon sends it (the fixture has none of its own). */
  const push = (message: unknown) => {
    const page = BrowserPageMessage.parse(message);
    for (const listener of listeners) listener(page);
  };
  return { daemon, sink, view, sent, push, scheduled };
}

const state = (sink: RecordingSink) =>
  sink.read("browser:view")?.state as
    | { url: string; activeTabId: string | null; tabs: { id: string; title: string }[] }
    | null
    | undefined;

describe("Live browser view", () => {
  test("a thread with an open tab offers its browser; one without doesn't", async () => {
    const withBrowser = await live();
    withBrowser.view.probe("web", 3);
    await until(() => withBrowser.sink.read("browser:available") !== undefined, "probe");
    expect(withBrowser.sink.read("browser:available")).toMatchObject({ live: true, epoch: 3 });

    const without = await live({ browser: false });
    without.view.probe("web", 1);
    await until(() => without.sink.read("browser:available") !== undefined, "probe");
    expect(without.sink.read("browser:available")).toMatchObject({ live: false });
  });

  test("opening sizes the page to the phone and shows the browser's address", async () => {
    const { daemon, sink, view } = await live();
    expect(view.action({ kind: "open", threadId: "web", viewport })).toBe(true);
    await until(() => state(sink)?.url === "https://shop.test/cart", "browser state");
    await until(() => daemon.browser.frame("web")?.width === 390, "resized page");
    expect(daemon.browser.frame("web")?.height).toBe(700);
    expect(state(sink)?.tabs).toHaveLength(1);
  });

  test("the person's touches reach the shown tab", async () => {
    const { daemon, sink, view } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink)?.activeTabId != null, "browser state");
    const touch = {
      kind: "touch",
      event: "touchStart",
      points: [{ x: 120, y: 300, id: 0 }],
    };
    expect(view.action({ kind: "input", input: touch })).toBe(true);
    await until(() => daemon.browser.wireInputs.length > 0, "input");
    expect(daemon.browser.wireInputs[0]).toEqual({
      threadId: "web",
      tabId: state(sink)?.activeTabId,
      input: touch,
    });
    // Input the protocol doesn't take is refused before it is sent.
    expect(view.action({ kind: "input", input: { kind: "touch", event: "wave" } })).toBe(false);
  });

  test("a picture on screen is acknowledged, a decode error asks for a keyframe", async () => {
    const { sink, view, sent } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink) != null, "browser state");
    view.action({ kind: "ack", sequence: 4 });
    view.action({ kind: "ack", sequence: 9, video: true, keyframe: true });
    expect(sent).toMatchObject([
      { type: "browser.ack", threadId: "web", sequence: 4 },
      { type: "browser.ack", threadId: "web", sequence: 9, video: true, keyframe: true },
    ]);
    expect(sent[0]).not.toHaveProperty("video");
  });

  test("switching tabs starts the pictures again and shows the new tab's page state", async () => {
    const { daemon, sink, view, push } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink)?.activeTabId != null, "browser state");
    const first = state(sink)?.activeTabId ?? "";
    const generation = sink.read("browser:view")?.generation as number;
    const opened = daemon.browser.personOpen("web", "https://shop.test/pay");
    push({
      type: "browser.page",
      threadId: "web",
      tabId: opened,
      page: { focus: { type: "email", rect: { x: 10, y: 20, width: 200, height: 30 } } },
    });
    push({
      type: "browser.page",
      threadId: "web",
      tabId: first,
      page: { cursor: "pointer" },
    });
    view.action({ kind: "tab", tabId: opened });
    await until(() => state(sink)?.activeTabId === opened, "tab switch");
    expect(sink.read("browser:view")?.generation).toBeGreaterThan(generation);
    // The new tab's earlier report was cleared with the restart; its next one shows.
    push({
      type: "browser.page",
      threadId: "web",
      tabId: opened,
      page: {
        picker: {
          pickerId: "p1",
          kind: "select",
          rect: { x: 0, y: 0, width: 100, height: 20 },
          value: "b",
          options: [
            { value: "a", label: "Air" },
            { value: "b", label: "Boat" },
          ],
        },
      },
    });
    expect(sink.read("browser:page")).toMatchObject({
      tabId: opened,
      page: { picker: { pickerId: "p1", value: "b" } },
    });
    push({ type: "browser.page", threadId: "web", tabId: first, page: { cursor: "text" } });
    expect(sink.read("browser:page")).toMatchObject({ tabId: opened });
  });

  test("closing the view stops its patches; a browser that isn't open yet is asked again", async () => {
    const { daemon, sink, view, scheduled } = await live({ browser: false });
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => sink.read("browser:view")?.error != null, "refused subscribe");
    expect(scheduled.length).toBe(1);
    daemon.browser.drive("web", { url: "https://shop.test/" });
    scheduled.shift()?.();
    await until(() => state(sink)?.url === "https://shop.test/", "subscribed later");
    expect(sink.read("browser:view")?.error).toBeNull();
    view.close();
    expect(sink.read("browser:view")).toBeUndefined();
    expect(view.action({ kind: "ack", sequence: 1 })).toBe(false);
  });
});
