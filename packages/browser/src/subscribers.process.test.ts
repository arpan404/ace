import { expect, test } from "vitest";
import { connectBrowser } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import type { BrowserServerMessage } from "@ace/protocol";

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
    await f.service.takeover("thread", "tabs");
    expect(messages.slice(before)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ controller: "human" }),
      }),
    );
    await subscribe("second", "browser.unsubscribe");
    const after = messages.length;
    f.service.handback("thread", "tabs");
    expect(messages.slice(after).some((message) => message.type === "browser.state")).toBe(false);
  } finally {
    connection.close();
  }
});

test("Preview rebinds after reopen and every joining subscriber receives state and the latest frame", async () => {
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
    expect(messages.slice(before)).toContainEqual(
      expect.objectContaining({ type: "browser.frame" }),
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
      expect.objectContaining({ type: "browser.frame" }),
    );
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
    f.service.takeover("thread", "tabs");
    expect(messages.slice(before)).toContainEqual(
      expect.objectContaining({
        type: "browser.state",
        state: expect.objectContaining({ controller: "human" }),
      }),
    );
  } finally {
    connection.close();
  }
});
