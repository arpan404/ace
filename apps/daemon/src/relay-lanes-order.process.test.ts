import { afterEach, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { slowLink } from "@ace/relay/testing/slow-link";
import { RelaySocket } from "./relay-socket.ts";

// Random mixes of what a daemon sends on a relayed main channel, through the real relay socket,
// channel and relay, over a link and a deflate with random timing. What must hold whatever the
// lanes do: every message arrives once; a message reaches the client before one sent ahead of
// it only when it says nothing about progress (a pong, or a batch that only adds output or asks
// a human) and passes only snapshots, pages or such batches about other threads and
// subscriptions; each subscription ends in the state strict order gives; close comes last.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** A small seeded generator, so a failure names the seed that reproduces it. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)),
    pick: <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T,
  };
}

const threads = { sa: "a", sb: "b", sc: "c" } as const;
type ThreadSubscription = keyof typeof threads;
const additive = ["item.delta", "item.created", "interaction.opened"];
const progress = ["agent.status", "run.ended", "item.updated", "thread.updated"];

interface Sent {
  n: number;
  kind: "snapshot" | "events" | "page" | "patch" | "receipt" | "pong" | "close";
  subscription?: string;
  /** Threads it is about; for events, its events' threads. */
  threads: string[];
  /** Only adds output or asks a human. */
  additive: boolean;
  text: string;
}

/** A random run: each thread subscription's snapshot before its events, then a mix. */
function scenario(seed: number): Sent[] {
  const random = generator(seed);
  const out: Sent[] = [];
  const pad = (bytes: number) => "x".repeat(bytes);
  const opened = new Set<ThreadSubscription>();
  const count = random.int(20, 45);
  for (let n = 0; out.length < count; n = out.length) {
    const subscription = random.pick(Object.keys(threads) as ThreadSubscription[]);
    const thread = threads[subscription];
    const roll = random.next();
    if (!opened.has(subscription)) {
      opened.add(subscription);
      out.push({
        n,
        kind: "snapshot",
        subscription,
        threads: [thread],
        additive: false,
        text: `{"type":"snapshot","subscriptionId":"${subscription}","n":${n},"seq":1,"view":{"pad":"${pad(random.int(1, 250) * 1024)}"}}`,
      });
    } else if (roll < 0.5) {
      const onlyAdds = random.next() < 0.6;
      const types = Array.from({ length: random.int(1, 3) }, () =>
        random.pick(onlyAdds ? additive : [...additive, ...progress]),
      );
      // Some batches are big enough to deflate off the event loop.
      const big = random.next() < 0.15 ? pad(300 * 1024) : pad(random.int(0, 2000));
      out.push({
        n,
        kind: "events",
        subscription,
        threads: [thread],
        additive: types.every((type) => additive.includes(type)),
        text: `{"type":"events","subscriptionId":"${subscription}","n":${n},"pad":"${big}","events":[${types.map((type) => `{"threadId":"${thread}","payload":{"type":"${type}"}}`).join(",")}]}`,
      });
    } else if (roll < 0.62)
      out.push({
        n,
        kind: "page",
        threads: [thread],
        additive: false,
        text: `{"type":"entities.page","requestId":"r${n}","n":${n},"page":{"threadId":"${thread}","pad":"${pad(random.int(1, 200) * 1024)}"}}`,
      });
    else if (roll < 0.75)
      out.push({
        n,
        kind: "patch",
        subscription: "side",
        threads: Object.values(threads),
        additive: false,
        text: `{"type":"threads.patch","subscriptionId":"side","n":${n},"done":"${thread}"}`,
      });
    else if (roll < 0.87)
      out.push({
        n,
        kind: "receipt",
        threads: [thread],
        additive: false,
        text: `{"type":"commandResult","commandId":"c${n}","n":${n},"status":"accepted"}`,
      });
    else
      out.push({ n, kind: "pong", threads: [], additive: true, text: `{"type":"pong","n":${n}}` });
  }
  if (random.next() < 0.5)
    out.push({
      n: out.length,
      kind: "close",
      threads: Object.values(threads),
      additive: false,
      text: "",
    });
  return out;
}

/** A per-subscription view built the way the client builds it: a snapshot after events is dropped. */
function views(order: Sent[]): Map<string, number[]> {
  const state = new Map<string, number[]>();
  const snapshotAllowed = new Set(Object.keys(threads));
  for (const message of order) {
    const subscription = message.subscription;
    if (subscription === undefined || subscription === "side") continue;
    if (message.kind === "snapshot") {
      if (snapshotAllowed.delete(subscription)) state.set(subscription, [message.n]);
    } else {
      snapshotAllowed.delete(subscription);
      state.set(subscription, [...(state.get(subscription) ?? []), message.n]);
    }
  }
  return state;
}

/** Whether `later` may reach the client before `earlier`, sent ahead of it. */
function mayPass(later: Sent, earlier: Sent): boolean {
  if (later.kind === "pong") return earlier.kind !== "close";
  if (!later.additive || later.kind !== "events") return false;
  const passable = earlier.kind === "snapshot" || (earlier.kind === "events" && earlier.additive);
  return (
    passable &&
    earlier.subscription !== later.subscription &&
    !earlier.threads.some((thread) => later.threads.includes(thread))
  );
}

async function relayed(seed: number) {
  const random = generator(seed ^ 0x9e3779b9);
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const proxy = await slowLink(relay.url, {
    bytesPerSecond: random.int(2, 8) * 1_000_000,
    roundTripMs: random.int(10, 80),
  });
  cleanup.push(() => proxy.close());
  const arrived = Promise.withResolvers<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: arrived.resolve,
    // Deflates that take a while, and now and then fail.
    deflate: async (json) => {
      await new Promise((resolve) => setTimeout(resolve, random.int(0, 60)));
      if (random.next() < 0.2) throw new Error("deflate failed");
      return deflateRawSync(json);
    },
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: proxy.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  const channel = await arrived.promise;
  client.lanes?.();
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
    flowControl: ["credit", "lanes"],
    compression: ["deflate-raw"],
  });
  await channel.receive();
  channel.authorize();
  channel.flowControl?.();
  channel.lanes?.();
  const socket = new RelaySocket(channel, { deflate: true, delay: () => () => {} });
  const seen = Promise.withResolvers<void>();
  let messages = 0;
  socket.on("message", () => {
    // The replayed hello, then one subscribe per thread subscription.
    if (++messages === 1 + Object.keys(threads).length) seen.resolve();
  });
  socket.start(JSON.stringify({ type: "hello" }));
  for (const [subscriptionId, threadId] of Object.entries(threads))
    await client.sendText(
      JSON.stringify({ type: "subscribe", subscriptionId, scope: { kind: "thread", threadId } }),
    );
  await seen.promise;
  return { socket, client };
}

async function deliver(seed: number): Promise<Sent[]> {
  const sent = scenario(seed);
  const { socket, client } = await relayed(seed);
  const random = generator(seed ^ 0x51ed270b);
  const failures: string[] = [];
  for (const message of sent) {
    if (message.kind === "close") socket.close(4000, "Reconnect with afterSeq");
    else
      socket.send(message.text, { compress: true }, (error) => {
        // A send that fails would lose the message: the check below names it.
        if (error) failures.push(`${message.kind}${message.n}: ${error.message}`);
      });
    // Sometimes a burst, sometimes a pause long enough for the link to drain a little.
    if (random.next() < 0.3) await new Promise((resolve) => setTimeout(resolve, random.int(1, 30)));
  }
  const byN = new Map(sent.map((message) => [message.n, message]));
  const order: Sent[] = [];
  while (order.length < sent.length) {
    const text = await client.receiveRaw();
    if (typeof text !== "string") throw new Error("Expected text");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("Expected an object");
    const n = "n" in parsed ? parsed.n : undefined;
    const message =
      "type" in parsed && parsed.type === "channel.close"
        ? sent.find((entry) => entry.kind === "close")
        : typeof n === "number"
          ? byN.get(n)
          : undefined;
    if (!message) throw new Error(`Unexpected message ${text.slice(0, 80)}`);
    order.push(message);
  }
  expect(failures).toEqual([]);
  return order;
}

it("random mixes reach the client in an order strict delivery could not tell apart", async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const sent = scenario(seed);
    const order = await deliver(seed);
    const context = `seed ${seed}: ${order.map((message) => `${message.kind}${message.n}`).join(" ")}`;
    // Each message once, close last.
    expect(
      order.map((message) => message.n).toSorted((x, y) => x - y),
      context,
    ).toEqual(sent.map((message) => message.n));
    if (sent.at(-1)?.kind === "close") expect(order.at(-1)?.kind, context).toBe("close");
    // Every overtake is one the rule allows.
    for (const [position, later] of order.entries())
      for (const earlier of order.slice(position + 1))
        if (earlier.n < later.n)
          expect(
            mayPass(later, earlier),
            `${context}: ${later.kind}${later.n} passed ${earlier.kind}${earlier.n}`,
          ).toBe(true);
    // And every subscription ends where strict order leaves it.
    expect(views(order), context).toEqual(views(sent));
    for (const close of cleanup.splice(0).toReversed()) await close();
  }
}, 30_000);
