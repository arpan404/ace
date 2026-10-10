import { once } from "node:events";
import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
import { BrowserBackendRequest } from "@ace/protocol";
import type { NavigationClock } from "./navigation.ts";

function clock() {
  const timers = new Set<{ ms: number; run(): void }>();
  const port: NavigationClock = {
    now: () => 0,
    set(ms, run) {
      const timer = { ms, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  };
  return {
    port,
    expireCommands() {
      for (const timer of timers) if (timer.ms === 30_000) timer.run();
    },
  };
}
async function native(options: Parameters<typeof backendFixture>[0] = {}) {
  const f = await backendFixture(options, { nativeTabs: true });
  await f.open();
  const sessionId = [...f.pages.keys()][0];
  const page = sessionId ? f.pages.get(sessionId) : undefined;
  if (!sessionId || !page) throw new Error("Missing page");
  const command = page.command.bind(page);
  page.command = (method, params) =>
    method === "Network.getResponseBody"
      ? { body: `body-${String(params?.requestId)}`, base64Encoded: false }
      : command(method, params);
  const event = (method: string, params: unknown) =>
    f.sendEvent(sessionId, "ace.tabs.event", { tabId: "native-tab", method, params });
  const response = (id: string) => {
    event("Network.requestWillBeSent", {
      requestId: id,
      request: { url: "http://localhost:3000/body" },
    });
    event("Network.responseReceived", {
      requestId: id,
      response: { url: "http://localhost:3000/body", status: 200, mimeType: "application/json" },
    });
    event("Network.loadingFinished", { requestId: id, encodedDataLength: 10 });
  };
  const barrier = () =>
    f.service.execute(
      "thread",
      { action: "screenshot" },
      { kind: "human", connectionId: "person" },
    );
  return { ...f, sessionId, page, event, response, barrier };
}

it("embedded private response ids remain unavailable after handback, while new shared bodies can be read", async () => {
  const f = await native();
  f.response("400.1");
  await f.barrier();
  expect(
    await f.service.execute("thread", { action: "network_body", requestId: "native-tab:400.1" }),
  ).toMatchObject({ body: "body-400.1" });
  f.service.takeover("thread", "person", "private");
  await f.barrier();
  f.response("400.2");
  await f.barrier();
  f.service.handback("thread", "person");
  await f.barrier();
  for (const id of ["400.1", "400.2"])
    await expect(
      f.service.execute("thread", { action: "network_body", requestId: `native-tab:${id}` }),
    ).rejects.toThrow(/unavailable/);
  f.response("400.3");
  await f.barrier();
  expect(
    await f.service.execute("thread", { action: "network_body", requestId: "native-tab:400.3" }),
  ).toMatchObject({ body: "body-400.3" });
});

it("a body read already in flight cannot cross a private takeover", async () => {
  const f = await native();
  f.response("400.1");
  await f.barrier();
  f.hold("Network.getResponseBody");
  const sent = once(f.requests, "Network.getResponseBody");
  const body = f.service.execute("thread", {
    action: "network_body",
    requestId: "native-tab:400.1",
  });
  const rejected = expect(body).rejects.toThrow(/unavailable|human_private/);
  const [raw] = await sent;
  const request = BrowserBackendRequest.parse(raw);
  f.service.takeover("thread", "person", "private");
  f.reply(request, { body: "private-marker", base64Encoded: false });
  await rejected;
});

it("SPA navigation updates the URL given to agents and people", async () => {
  const f = await backendFixture();
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/first" });
  const id = [...f.pages.keys()][0];
  if (!id) throw new Error("Missing page");
  f.sendEvent(id, "Page.navigatedWithinDocument", {
    frameId: "main",
    url: "http://localhost:3000/second#part",
  });
  await f.service.execute("thread", { action: "screenshot" });
  expect(f.service.state("thread").url).toBe("http://localhost:3000/second#part");
  f.sendEvent(id, "Page.navigatedWithinDocument", {
    frameId: "child",
    url: "http://localhost:3000/iframe",
  });
  await f.service.execute("thread", { action: "screenshot" });
  expect(f.service.state("thread").url).toBe("http://localhost:3000/second#part");
});

it("Find reads the page while the agent keeps control", async () => {
  const f = await native();
  await f.service.execute(
    "thread",
    { action: "find_text", text: "marker" },
    { kind: "human", connectionId: "person" },
  );
  expect(f.service.state("thread").controller).toBe("agent");
  await f.service.execute("thread", { action: "press", key: "a" });
});

it("a legacy new-tab request navigates the existing page", async () => {
  const f = await native();
  const before = f.service.state("thread").activeTabId;
  await f.service.execute("thread", {
    action: "tabs",
    operation: "open",
    url: "http://localhost:3000/next",
  });
  expect(f.service.state("thread")).toMatchObject({
    activeTabId: before,
    url: "http://localhost:3000/next",
    tabs: [{ tabId: before }],
  });
});

it("Reopen restores a lost native page with its thread profile and human lease", async () => {
  const f = await backendFixture({ profilePreference: () => "persistent" });
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/last" });
  f.service.takeover("thread", "person");
  await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "person");
  const id = [...f.pages.keys()][0];
  if (!id) throw new Error("Missing page");
  const paused = Promise.withResolvers<void>();
  f.service.subscribe("thread", "viewer", { send: () => true }, (state) => {
    if (state.status === "paused") paused.resolve();
  });
  f.sendEvent(id, "Inspector.detached", { reason: "crashed" });
  await paused.promise;
  await f.open();
  expect(f.service.state("thread")).toMatchObject({
    status: "ready",
    backend: "embedded",
    url: "http://localhost:3000/last",
    controller: "human",
    owner: "person",
  });
  await f.service.input("thread", { kind: "key", event: "char", key: "y" }, "person");
  expect([...f.pages.values()].at(-1)?.text).toBe("y");
  expect(f.headless.pages).toHaveLength(0);
});

it("an unanswered dialog preserves the session beyond the input relay deadline", async () => {
  const time = clock();
  const f = await native({ navigationClock: time.port });
  f.service.takeover("thread", "person");
  await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "person");
  f.hold("Input.insertText");
  const sent = once(f.requests, "Input.insertText");
  const input = f.service.input("thread", { kind: "key", event: "char", key: "a" }, "person");
  const [raw] = await sent;
  const request = BrowserBackendRequest.parse(raw);
  f.event("Page.javascriptDialogOpening", { type: "confirm", message: "Continue?" });
  // A public read waits for the dialog event to arrive over the real relay.
  await expect.poll(() => f.service.state("thread").pending_dialog?.message).toBe("Continue?");
  time.expireCommands();
  expect(f.service.state("thread").status).toBe("ready");
  f.releaseHold();
  const dialogId = f.service.state("thread").pending_dialog?.dialogId;
  await f.service.execute(
    "thread",
    { action: "dialog", dialogId, accept: true },
    { kind: "human", connectionId: "person" },
  );
  f.reply(request, {});
  await input;
  expect(f.service.state("thread").pending_dialog).toBeUndefined();
});

it("capacity evicts the oldest idle shared page and preserves human and private pages", async () => {
  let now = 0;
  const f = await backendFixture({ maxSessions: 2, now: () => ++now });
  await f.open("old");
  await f.open("held");
  f.service.takeover("held", "person", "private");
  now += 30_000;
  await f.open("new");
  expect(() => f.service.state("old")).toThrow(/not open/);
  expect(f.service.state("held").takeoverMode).toBe("private");
  f.service.takeover("new", "person");
  await expect(f.open("another")).rejects.toThrow(/All browser pages are in use/);
});

it("link loading, failure, permission denial and Stop appear in public browser state", async () => {
  const f = await native();
  f.event("Page.frameNavigated", { frame: { id: "main", url: "http://localhost:3000/" } });
  f.event("Page.frameStartedLoading", { frameId: "main" });
  await f.barrier();
  expect(f.service.state("thread").loading).toBe(true);
  f.event("Network.requestWillBeSent", { requestId: "child", frameId: "iframe", type: "Document" });
  f.event("Network.loadingFailed", {
    requestId: "child",
    type: "Document",
    errorText: "net::ERR_CONNECTION_REFUSED",
  });
  await f.barrier();
  expect(f.service.state("thread").loadError).toBeUndefined();
  f.event("Network.requestWillBeSent", { requestId: "main", frameId: "main", type: "Document" });
  f.event("Network.loadingFailed", {
    requestId: "main",
    type: "Document",
    errorText: "net::ERR_CONNECTION_REFUSED",
  });
  f.sendEvent(f.sessionId, "ace.permissionDenied", {
    origin: "http://localhost:3000",
    permission: "media",
  });
  await f.barrier();
  expect(f.service.state("thread")).toMatchObject({
    loading: false,
    loadError: "net::ERR_CONNECTION_REFUSED",
    permissionDenied: { permission: "media" },
  });
  await f.service.execute("thread", { action: "history", direction: "stop" });
});

it("a visible native page reduces Chromium capture and a remote viewer restores live cadence", async () => {
  let now = 0;
  const f = await backendFixture({ now: () => now });
  await f.open();
  f.service.subscribe(
    "thread",
    "viewer",
    {
      send: (frame) => {
        f.service.acknowledge("thread", "viewer", frame.sequence);
        return true;
      },
    },
    () => {},
  );
  const viewport = { width: 800, height: 600, devicePixelRatio: 1 };
  const warm = once(f.requests, "Page.startScreencast");
  f.service.configureCapture("thread", "viewer", {
    viewport: { ...viewport, nativeShown: true },
    local: true,
  });
  now = 2000;
  const [nativeRequest] = await warm;
  expect(BrowserBackendRequest.parse(nativeRequest)).toMatchObject({
    operation: { kind: "cdp", params: { everyNthFrame: 60 } },
  });
  const full = once(f.requests, "Page.startScreencast");
  f.service.configureCapture("thread", "viewer", {
    viewport: { ...viewport, nativeShown: false },
    local: false,
  });
  now = 4000;
  const [remoteRequest] = await full;
  expect(BrowserBackendRequest.parse(remoteRequest)).toMatchObject({
    operation: { kind: "cdp", params: { everyNthFrame: 1 } },
  });
});
