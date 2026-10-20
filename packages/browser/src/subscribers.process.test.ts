import { expect, test } from "vitest";
import { connectBrowser } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import { keepAgentsOut } from "./collaboration-test-support.ts";
import type { BrowserServerMessage } from "@ace/protocol";

function expectReopened(messages: BrowserServerMessage[]): void {
  expect(messages).toContainEqual(
    expect.objectContaining({
      type: "browser.state",
      state: expect.objectContaining({ closed: false }),
    }),
  );
}

test("subscriber IDs retain browser delivery until the final subscriber leaves", async () => {
  const f = await backendFixture();
  await f.open();
  const messages: BrowserServerMessage[] = [];
  const connection = connectBrowser(f.service, {
    connectionId: "tabs",
    authorize: () => true,
    send(message) {
      messages.push(message);
      return true;
    },
  });
  const subscribe = (id: string, type: "browser.subscribe" | "browser.unsubscribe") =>
    connection.handle({ type, threadId: "thread", requestId: `${type}-${id}`, subscriberId: id });
  try {
    await subscribe("first", "browser.subscribe");
    await subscribe("second", "browser.subscribe");
    await subscribe("second", "browser.subscribe");
    await subscribe("first", "browser.unsubscribe");
    const before = messages.length;
    keepAgentsOut(f.service);
    expect(messages.slice(before)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ closed: false }),
      }),
    );
    await subscribe("second", "browser.unsubscribe");
    const after = messages.length;
    keepAgentsOut(f.service, "thread", false);
    expect(messages.slice(after).some((message) => message.type === "browser.state")).toBe(false);
  } finally {
    connection.close();
  }
});

test("Preview rebinds after reopen and every joining subscriber receives state", async () => {
  const f = await backendFixture();
  await f.open();
  const messages: BrowserServerMessage[] = [];
  const connection = connectBrowser(f.service, {
    connectionId: "tabs",
    authorize: () => true,
    send(message) {
      messages.push(message);
      return true;
    },
  });
  const subscribe = (subscriberId: string) =>
    connection.handle({
      type: "browser.subscribe",
      threadId: "thread",
      requestId: subscriberId,
      subscriberId,
    });
  try {
    await subscribe("first");
    let before = messages.length;
    await subscribe("second");
    expect(messages.slice(before)).toContainEqual(
      expect.objectContaining({ type: "browser.state" }),
    );
    await connection.handle({ type: "browser.close", threadId: "thread", requestId: "close" });
    await connection.handle({
      type: "browser.open",
      options: { threadId: "thread", workspaceId: "workspace-thread" },
      requestId: "open",
    });
    before = messages.length;
    await subscribe("first");
    expect(messages.slice(before)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ closed: false }),
      }),
    );
    await connection.handle({
      type: "browser.unsubscribe",
      threadId: "thread",
      subscriberId: "first",
      requestId: "leave",
    });
    before = messages.length;
    keepAgentsOut(f.service);
    expect(messages.slice(before)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ closed: false }),
      }),
    );
  } finally {
    connection.close();
  }
});

test("every Preview connection keeps following state when another connection or the service reopens the browser", async () => {
  const f = await backendFixture({ backendPreference: () => "headless" });
  await f.open();
  const first: BrowserServerMessage[] = [];
  const second: BrowserServerMessage[] = [];
  const bridge = (connectionId: string, messages: BrowserServerMessage[]) =>
    connectBrowser(f.service, {
      connectionId,
      authorize: () => true,
      send(message) {
        messages.push(message);
        return true;
      },
    });
  const a = bridge("first", first);
  const b = bridge("second", second);

  try {
    for (const connection of [a, b])
      await connection.handle({
        type: "browser.subscribe",
        threadId: "thread",
        subscriberId: "viewer",
        requestId: "join",
      });
    await b.handle({ type: "browser.close", threadId: "thread", requestId: "close" });
    const beforeA = first.length,
      beforeB = second.length;
    await b.handle({
      type: "browser.open",
      options: { threadId: "thread", workspaceId: "workspace-thread" },
      requestId: "open",
    });
    expectReopened(first.slice(beforeA));
    expectReopened(second.slice(beforeB));
    const privately = first.length;
    await b.handle({
      type: "browser.tabs.private",
      threadId: "thread",
      tabId: "page",
      private: true,
      requestId: "private",
    });
    expect(first.slice(privately)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ closed: false }),
      }),
    );
    await f.service.closeThread("thread");
    const directA = first.length,
      directB = second.length;
    await f.open();
    expectReopened(first.slice(directA));
    expectReopened(second.slice(directB));
    await a.handle({
      type: "browser.unsubscribe",
      threadId: "thread",
      subscriberId: "viewer",
      requestId: "leave",
    });
    const afterA = first.length,
      afterB = second.length;
    keepAgentsOut(f.service);
    expect(first.slice(afterA).some((m) => m.type === "browser.state")).toBe(false);
    expect(second.slice(afterB)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ closed: false }),
      }),
    );
    // Unsubscription must also remain effective on the next physical session.
    await f.service.closeThread("thread");
    const detached = first.length;
    await f.open();
    expect(first.slice(detached)).toEqual([]);
  } finally {
    a.close();
    b.close();
  }
});

test("closed Preview subscriptions retain bounded admission until an idempotent unsubscribe frees it", async () => {
  const f = await backendFixture({ maxSessions: 1, backendPreference: () => "headless" });
  await f.open();
  const stops: (() => void)[] = [];
  /** Which viewers were told the browser's state. */
  const told: string[] = [];
  const subscribe = (threadId: string, connectionId: string) =>
    f.service.subscribe(threadId, connectionId, {}, () => told.push(connectionId));
  try {
    for (let i = 0; i < 64; i++) stops.push(subscribe("thread", `viewer-${i}`));
    await f.service.closeThread("thread");
    await f.open("replacement");
    expect(() => subscribe("replacement", "new-viewer")).toThrow("Browser subscriber limit");
    const stop = stops[0];
    if (!stop) throw new Error("Subscriber missing");
    stop();
    stop();
    told.length = 0;
    stops.push(subscribe("replacement", "new-viewer"));
    expect(told).toEqual(["new-viewer"]);
    expect(() => subscribe("replacement", "overflow")).toThrow("Browser subscriber limit");
  } finally {
    for (const stop of stops) stop();
  }
});

test("a viewer leaving while the replacement page's state reaches it is told nothing further", async () => {
  const f = await backendFixture({ backendPreference: () => "headless" });
  await f.open();
  let stop: (() => void) | undefined;
  let leave = false;
  let told = 0;
  stop = f.service.subscribe("thread", "viewer", {}, () => {
    told++;
    if (leave) stop?.();
  });
  try {
    await f.service.closeThread("thread");
    leave = true;
    told = 0;
    await f.open();
    expect(told).toBe(1);
    keepAgentsOut(f.service);
    expect(told).toBe(1);
  } finally {
    stop();
  }
});
