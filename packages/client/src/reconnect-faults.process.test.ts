import { afterEach, expect, test } from "vitest";
import { scripted } from "./scripted-server.fixture.ts";
import { when } from "./test-support.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

test("the client retries after 1009", async () => {
  const h = await scripted();
  close = h.close;
  void h.client.start();
  const first = await h.connection(0);
  await first.next("hello");
  first.close(1009, "Message too big");
  await when(h.client.connectionState(), (state) => state === "reconnecting");
  expect(h.client.connectionInfo().getSnapshot()).toMatchObject({
    attempt: 1,
    lastClose: { code: 1009, reason: "Message too big" },
  });
  // Nothing reconnects before the backoff runs out.
  const second = h.connection(1);
  h.scheduler.advance(30_000);
  const peer = await second;
  await peer.next("hello");
  peer.welcome();
  await when(h.client.connectionState(), (state) => state === "ready");
  expect(h.client.error).toBeUndefined();
});

test("an undecodable server message reconnects and reports a version mismatch", async () => {
  const h = await scripted();
  close = h.close;
  void h.client.start();
  const info = h.client.connectionInfo();
  for (let index = 0; index < 2; index++) {
    const peer = await h.connection(index);
    await peer.next("hello");
    peer.welcome();
    await when(h.client.connectionState(), (state) => state === "ready");
    // A frame only a newer daemon would send.
    peer.send({ type: "thread.teleported", threadId: "thread" });
    await when(h.client.connectionState(), (state) => state === "reconnecting");
    expect(h.client.error?.code).toBe("version_mismatch");
    // Each mismatch backs off further: a welcome that soon fails doesn't reset the count.
    expect(info.getSnapshot()).toMatchObject({ attempt: index + 1, lastClose: { code: 1002 } });
    h.scheduler.advance(30_000);
  }
  const good = await h.connection(2);
  await good.next("hello");
  good.welcome();
  await when(h.client.connectionState(), (state) => state === "ready");
  expect(h.client.error).toBeUndefined();
});

test("a welcome for another protocol version is a version mismatch that keeps retrying", async () => {
  const h = await scripted();
  close = h.close;
  void h.client.start();
  const old = await h.connection(0);
  await old.next("hello");
  old.welcome(2);
  await when(h.client.connectionState(), (state) => state === "reconnecting");
  expect(h.client.error?.code).toBe("version_mismatch");
  const next = h.connection(1);
  h.scheduler.advance(30_000);
  const peer = await next;
  await peer.next("hello");
  peer.welcome();
  await when(h.client.connectionState(), (state) => state === "ready");
  expect(h.client.error).toBeUndefined();
});
