import { afterEach, expect, test } from "vitest";
import { hostId, scripted } from "./scripted-server.fixture.ts";
import { when } from "./test-support.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const page = (requestId: string, threadId: string) => ({
  type: "items.page",
  requestId,
  seq: 0,
  threadId,
  items: [],
  itemsBefore: null,
});

test("the client says it reads packed frames, and reads each message of one in order", async () => {
  const h = await scripted();
  close = h.close;
  void h.client.start();
  const peer = await h.connection(0);
  const hello = await peer.next("hello");
  expect(hello.framing).toEqual(["lines"]);
  // `starting` must be read before `welcome`, or the connection never becomes ready.
  peer.sendPacked([
    { type: "starting" },
    { type: "welcome", hostId, protocolVersion: 1, headSeq: 0 },
  ]);
  await when(h.client.connectionState(), (state) => state === "ready");

  const first = h.client.itemsPage({ threadId: "one", limit: 1 });
  const second = h.client.itemsPage({ threadId: "two", limit: 1 });
  const a = await peer.next("items.page");
  const b = await peer.next("items.page");
  peer.sendPacked([page(a.requestId, a.threadId), page(b.requestId, b.threadId)]);
  await expect(first).resolves.toMatchObject({ threadId: "one" });
  await expect(second).resolves.toMatchObject({ threadId: "two" });
});
