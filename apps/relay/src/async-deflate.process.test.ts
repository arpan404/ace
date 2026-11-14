import { afterEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "./index.ts";
import { LOGICAL_MESSAGE_LIMIT } from "./channel.ts";
import type { HostChannel } from "./index.ts";
import { deferred } from "./testing/peer.ts";

// Large JSON messages deflate off the event loop, and still go strictly in order: one being
// deflated holds back everything queued after it. A real relay and real channels.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function connected(
  deflate?: (json: Uint8Array) => Promise<Uint8Array>,
  options: { flowControl?: boolean; log?: (error: Error) => void } = {},
) {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = deferred<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: arrived.resolve,
    ...(deflate ? { deflate } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  const server = await arrived.promise;
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
    compression: ["deflate-raw"],
  });
  await server.receive();
  server.authorize();
  if (options.flowControl) {
    // The client's channel limits itself once the daemon's first credit arrives.
    server.flowControl?.();
    await server.send({ type: "pong" });
    await client.receive();
  }
  return { client, server };
}

/** JSON text of about `bytes` that deflates well, tagged so the reader can tell it apart. */
const bulky = (tag: string, bytes: number) =>
  JSON.stringify({ type: "pong", tag, data: `${tag} line of output `.repeat(bytes / 24) });
const tagOf = (text: string | Uint8Array) =>
  typeof text === "string" ? (JSON.parse(text) as { tag?: string }).tag : "binary";
/** JSON text of exactly `bytes` bytes that deflates well, tagged. */
function compressible(tag: string, bytes: number): string {
  const head = `{"type":"pong","tag":"${tag}","data":"`;
  return `${head}${"line of output ".repeat(bytes / 15 + 1).slice(0, bytes - head.length - 2)}"}`;
}
/** JSON text of exactly `bytes` bytes. */
const exactly = (bytes: number) => `{"type":"pong","pad":"${"x".repeat(bytes - 24)}"}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("a large message deflates off the event loop and holds back what was sent after it", async () => {
  // Also guards a past bug: the compress flag shadowed the deflate, so large messages never
  // reached it (they failed to send; with the fallback they would now go uncompressed).
  const release = Promise.withResolvers<void>();
  const { client, server } = await connected(async (json) => {
    await release.promise;
    return deflateRawSync(json);
  });
  const big = bulky("big", 2 * 1024 * 1024);
  const sends = [server.sendText(big, true), server.sendText(bulky("small", 2000), true)];
  // The event loop keeps running while the deflate is out, and nothing has gone ahead of it.
  await sleep(100);
  let early: string | undefined;
  void client.receiveRaw().then((text) => (early = tagOf(text)));
  await sleep(100);
  expect(early).toBeUndefined();
  release.resolve();
  await Promise.all(sends);
  await sleep(50);
  expect(early).toBe("big");
  expect(tagOf(await client.receiveRaw())).toBe("small");
});

it("messages keep their order through slow deflates of different lengths", async () => {
  const { client, server } = await connected(async (json) => {
    // The first large message takes longest: a later one finishing first must still wait.
    await sleep(json.length > 3 * 1024 * 1024 ? 300 : 20);
    return deflateRawSync(json);
  });
  const texts = [
    bulky("first", 4 * 1024 * 1024),
    bulky("tiny", 100),
    bulky("second", 512 * 1024),
    bulky("mid", 50_000),
  ];
  const sends = texts.map((text) => server.sendText(text, true));
  for (const text of texts) expect(await client.receiveRaw()).toBe(text);
  await Promise.all(sends);
});

it("a deflate that fails sends the message as it is, still in order, and says so once", async () => {
  const logged: Error[] = [];
  const { client, server } = await connected(
    async () => {
      throw new Error("deflate failed");
    },
    { log: (error) => logged.push(error) },
  );
  const texts = [bulky("big", 1024 * 1024), bulky("after", 100), bulky("again", 512 * 1024)];
  const sends = texts.map((text) => server.sendText(text, true));
  for (const text of texts) expect(await client.receiveRaw()).toBe(text);
  await Promise.all(sends);
  // One line per failed deflate, naming the message's size; the small one never deflated.
  expect(logged.map((error) => error.message)).toEqual([
    `Relay deflate failed for a ${new TextEncoder().encode(texts[0]).length}-byte message; sent uncompressed`,
    `Relay deflate failed for a ${new TextEncoder().encode(texts[2]).length}-byte message; sent uncompressed`,
  ]);
});

it("a large message sent with compression arrives whole through the real deflate", async () => {
  const { client, server } = await connected();
  const big = bulky("big", 8 * 1024 * 1024);
  const sent = server.sendText(big, true);
  expect(await client.receiveRaw()).toBe(big);
  await sent;
});

it("with the queue full behind a reader that stopped, large sends are refused before any deflate", async () => {
  let deflates = 0;
  const { server } = await connected(
    async (json) => {
      deflates++;
      return deflateRawSync(json);
    },
    { flowControl: true },
  );
  // The reader never reads: one window goes out, the rest waits in the channel, which these
  // fill to 1 KiB short of the 16 MiB it may hold ready to send.
  const fills = [...Array.from({ length: 3 }, () => 4 * 1024 * 1024), 4 * 1024 * 1024 - 1024];
  const filling = fills.map((bytes) => server.sendText(exactly(bytes), false).catch(() => {}));
  await sleep(200);
  // Even at deflate's best ratio these can't fit in 1 KiB: refused before any deflate.
  for (let index = 0; index < 5; index++)
    await expect(server.sendText(bulky(`more${index}`, 2 * 1024 * 1024), true)).rejects.toThrow(
      "send queue too large",
    );
  await expect(server.sendText(exactly(2048), false)).rejects.toThrow("send queue too large");
  expect(deflates).toBe(0);
  expect(server.bufferedBytes).toBeLessThanOrEqual(LOGICAL_MESSAGE_LIMIT);
  server.close();
  await Promise.all(filling);
}, 20_000);

it("two 9 MiB messages that deflate well, back to back, both arrive in order", async () => {
  // Accepted before deflates left the event loop (the limit counted deflated bytes), so still.
  const { client, server } = await connected();
  const texts = [compressible("first", 9 * 1024 * 1024), compressible("second", 9 * 1024 * 1024)];
  expect(texts.map((text) => text.length)).toEqual([9 * 1024 * 1024, 9 * 1024 * 1024]);
  const sends = texts.map((text) => server.sendText(text, true));
  for (const text of texts) expect(await client.receiveRaw()).toBe(text);
  await Promise.all(sends);
}, 20_000);

it("a closed channel refuses a large send without deflating it", async () => {
  let deflates = 0;
  const { server } = await connected(async (json) => {
    deflates++;
    return deflateRawSync(json);
  });
  server.close();
  await expect(server.sendText(bulky("late", 2 * 1024 * 1024), true)).rejects.toThrow(
    "Channel closed",
  );
  expect(deflates).toBe(0);
});

/** JSON text of exactly `bytes` bytes of base64, which deflates by only about a quarter. */
function base64Text(bytes: number): string {
  const head = '{"type":"pong","data":"';
  return `${head}${randomBytes(bytes)
    .toString("base64")
    .slice(0, bytes - head.length - 2)}"}`;
}

it("a slow deflate holds room for its whole message, so ready bytes never pass 16 MiB", async () => {
  const release = Promise.withResolvers<void>();
  const { server } = await connected(
    async (json) => {
      await release.promise;
      return deflateRawSync(json);
    },
    { flowControl: true },
  );
  // The reader never reads. 16 MiB held in its deflate holds room for all of itself, so
  // nothing fits behind it until the deflate is done.
  const first = server.sendText(base64Text(LOGICAL_MESSAGE_LIMIT), true).catch(() => {});
  for (let index = 0; index < 4; index++)
    await expect(server.sendText(exactly(4 * 1024 * 1024), false)).rejects.toThrow(
      "send queue too large",
    );
  expect(server.bufferedBytes).toBeLessThanOrEqual(LOGICAL_MESSAGE_LIMIT);
  release.resolve();
  await sleep(300);
  expect(server.bufferedBytes).toBeLessThanOrEqual(LOGICAL_MESSAGE_LIMIT);
  server.close();
  await first;
}, 20_000);

it("ending the channel while a deflate is held refuses every pending send at once", async () => {
  const release = Promise.withResolvers<void>();
  let finished = false;
  const { server } = await connected(async (json) => {
    await release.promise;
    finished = true;
    return deflateRawSync(json);
  });
  const outcomes: string[] = [];
  const settle = (name: string, sent: Promise<void>) =>
    sent.then(
      () => outcomes.push(`${name} sent`),
      (error: Error) => outcomes.push(`${name} ${error.message}`),
    );
  const sends = [
    settle("held", server.sendText(compressible("held", 2 * 1024 * 1024), true)),
    settle("behind", server.sendText(exactly(4096), false)),
    settle("goodbye", server.sendGoodbye('{"type":"channel.close","code":1000,"reason":""}')),
  ];
  await sleep(50);
  expect(server.unsentMessages).toBe(3);
  server.close();
  await Promise.all(sends);
  expect(outcomes).toEqual([
    "held Channel closed",
    "behind Channel closed",
    "goodbye Channel closed",
  ]);
  expect(server.unsentMessages).toBe(0);
  expect(server.bufferedBytes).toBe(0);
  // A deflate that finishes afterwards is discarded and counts for nothing.
  release.resolve();
  await sleep(50);
  expect(finished).toBe(true);
  expect(server.bufferedBytes).toBe(0);
});

it("the goodbye is sent once: a second one returns the first", async () => {
  const { client, server } = await connected();
  const goodbye = '{"type":"channel.close","code":1000,"reason":"first"}';
  const first = server.sendGoodbye(goodbye);
  expect(server.sendGoodbye('{"type":"channel.close","code":1000,"reason":"second"}')).toBe(first);
  const after = bulky("after", 100);
  await Promise.all([first, server.sendText(after, false)]);
  expect(await client.receiveRaw()).toBe(goodbye);
  expect(await client.receiveRaw()).toBe(after);
});

/** A full collection on Bun, the daemon's runtime, where this file runs. */
function collectGarbage(): void {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  const gc: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
  if (typeof gc !== "function") throw new Error("This test needs Bun's garbage collector");
  gc.call(bun, true);
}

it("a long run of sends and drains leaves nothing of them queued or reachable", async () => {
  const { client, server } = await connected();
  const kept: WeakRef<Uint8Array>[] = [];
  const reading = (async () => {
    for (let index = 0; index < 400; index++) await client.receiveRaw();
  })();
  for (let index = 0; index < 100; index++) {
    const bytes = new Uint8Array(32 * 1024).fill(index % 251);
    kept.push(new WeakRef(bytes));
    await Promise.all([
      server.sendBinary(bytes),
      server.sendText(compressible(`big${index}`, 512 * 1024), true),
      server.sendText(compressible(`mid${index}`, 64 * 1024), true),
      server.sendText(exactly(200), false),
    ]);
  }
  await reading;
  expect(server.unsentMessages).toBe(0);
  expect(server.bufferedBytes).toBe(0);
  // Nothing the channel holds still points at a sent message's bytes.
  collectGarbage();
  await sleep(10);
  collectGarbage();
  expect(kept.filter((ref) => ref.deref() !== undefined).length).toBeLessThanOrEqual(1);
}, 30_000);

it("an ignored send on a channel that then ends raises no unhandled rejection inside it", async () => {
  const unhandled: unknown[] = [];
  const listen = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  try {
    const release = Promise.withResolvers<void>();
    const { server } = await connected(async (json) => {
      await release.promise;
      return deflateRawSync(json);
    });
    // The caller keeps the public promise and handles it; nothing else may reject unseen.
    const outcomes = [
      server.sendText(compressible("held", 2 * 1024 * 1024), true),
      server.sendText(exactly(4096), false),
      server.sendBinary(new Uint8Array(1024)),
      server.sendGoodbye('{"type":"channel.close","code":1000,"reason":""}'),
    ].map((sent) => sent.catch((error: Error) => error.message));
    await sleep(20);
    server.close();
    expect(await Promise.all(outcomes)).toEqual(Array.from({ length: 4 }, () => "Channel closed"));
    release.resolve();
    await sleep(100);
    expect(server.unsentMessages).toBe(0);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listen);
  }
});
