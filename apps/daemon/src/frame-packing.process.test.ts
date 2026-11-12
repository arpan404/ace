import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { Event, ServerMessage } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { Outbox, RESYNC_CLOSE_CODE, defaultPressure, type PressureOptions } from "./outbox.ts";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

/** A real local WebSocket pair: the daemon's end and a client recording every frame. */
async function pair() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const connected = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const frames: string[] = [];
  const arrived: (() => void)[] = [];
  client.on("message", (data) => {
    frames.push(data.toString());
    for (const wake of arrived.splice(0)) wake();
  });
  await once(client, "open");
  const [socket] = await connected;
  if (!(socket instanceof WebSocket)) throw new Error("Missing server socket");
  closers.push(async () => {
    if (client.readyState !== WebSocket.CLOSED) {
      const closed = once(client, "close");
      client.terminate();
      await closed;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  /** Every message received so far, a packed frame read line by line. */
  const messages = () =>
    frames
      .flatMap((frame) => frame.split("\n"))
      .map((line) => ServerMessage.parse(JSON.parse(line)));
  return {
    socket,
    client,
    frames,
    messages,
    async until(count: number) {
      while (messages().length < count) await new Promise<void>((wake) => arrived.push(wake));
    },
    /** A ping answered after everything the daemon had sent before it: a delivery barrier. */
    async roundTrip() {
      const pong = once(client, "pong");
      client.ping();
      await pong;
    },
  };
}

/** A hold timer the test fires by hand. */
function manualDelay() {
  const timers: { callback: () => void; ms: number; live: boolean }[] = [];
  return {
    timers,
    delay(callback: () => void, ms: number) {
      const timer = { callback, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    fire() {
      for (const timer of timers.splice(0)) if (timer.live) timer.callback();
    },
  };
}

let seq = 0;
function delta(append: string): ServerMessage {
  seq++;
  return {
    type: "events",
    subscriptionId: "s",
    afterSeq: seq - 1,
    throughSeq: seq,
    events: [
      Event.parse({
        seq,
        id: `e${seq}`,
        at: 0,
        threadId: "t",
        payload: { type: "item.delta", itemId: "i", agentId: "a", field: "text", append },
      }),
    ],
  };
}
function titled(title: string): ServerMessage {
  seq++;
  return {
    type: "events",
    subscriptionId: "s",
    afterSeq: seq - 1,
    throughSeq: seq,
    events: [
      Event.parse({
        seq,
        id: `e${seq}`,
        at: 0,
        threadId: "t",
        payload: { type: "thread.updated", title },
      }),
    ],
  };
}

function outbox(
  socket: WebSocket,
  delay: typeof systemDeliveryRuntime.delay,
  pressure: Partial<PressureOptions> = {},
) {
  return new Outbox(
    socket,
    { ...defaultPressure, ...pressure },
    systemDeliveryRuntime.now,
    undefined,
    delay,
  );
}

it("a client that unpacks frames reads exactly the messages, in order, that a one-per-frame client reads", async () => {
  seq = 0;
  const script: ServerMessage[] = [
    delta("Hel"),
    delta("lo, "),
    delta("world\nwith a newline"),
    titled("A status change goes at once"),
    delta("more"),
    { type: "error", code: "page_failed", message: "Could not read", requestId: "r1" },
    { type: "pong" },
    delta("tail "),
    delta("end"),
  ];
  const plain = await pair();
  const plainOut = outbox(plain.socket, systemDeliveryRuntime.delay);
  for (const message of script) plainOut.send(message);
  await plain.until(script.length);

  const packed = await pair();
  const packedOut = outbox(packed.socket, systemDeliveryRuntime.delay);
  packedOut.packFrames();
  for (const message of script) packedOut.send(message);
  await packed.until(script.length);

  expect(plain.messages()).toEqual(script);
  expect(packed.messages()).toEqual(plain.messages());
  expect(plain.frames).toHaveLength(script.length);
  // Three runs of deltas, each ended by something that cannot wait or by the clock.
  expect(packed.frames.length).toBeLessThan(script.length);
});

it("a streamed delta waits at most the hold time, and anything a person waits on sends it at once", async () => {
  seq = 0;
  const { socket, frames, messages, roundTrip } = await pair();
  const clock = manualDelay();
  const out = outbox(socket, clock.delay);
  out.packFrames();

  out.send(delta("a"));
  out.send(delta("b"));
  await roundTrip();
  expect(frames).toEqual([]);
  expect(clock.timers.map((timer) => timer.ms)).toEqual([16]);
  clock.fire();
  await roundTrip();
  expect(frames).toHaveLength(1);
  expect(messages().map((message) => message.type)).toEqual(["events", "events"]);

  // A status change is transcript too: it takes the held delta along in its own frame, at once.
  out.send(delta("c"));
  const status = titled("Done");
  out.send(status);
  await roundTrip();
  expect(frames).toHaveLength(2);
  expect(messages().slice(2)).toEqual([expect.objectContaining({ type: "events" }), status]);

  // A reply the compression policy keeps apart goes alone, right after what was held.
  const reply: ServerMessage = { type: "error", code: "denied", message: "No", requestId: "r" };
  out.send(delta("d"));
  out.send(reply);
  await roundTrip();
  expect(frames).toHaveLength(4);
  expect(messages().slice(4)).toEqual([expect.objectContaining({ type: "events" }), reply]);
  expect(clock.timers.filter((timer) => timer.ms === 16)).toHaveLength(2);
});

it("a client that did not ask for packing gets one message per frame and no holding", async () => {
  seq = 0;
  const { socket, frames, roundTrip } = await pair();
  const clock = manualDelay();
  const out = outbox(socket, clock.delay);
  out.send(delta("a"));
  out.send(delta("b"));
  await roundTrip();
  expect(frames).toHaveLength(2);
  expect(clock.timers).toEqual([]);
});

it("held deltas count against the outbox budget, so a stalled stream still resyncs", async () => {
  seq = 0;
  const { socket, client } = await pair();
  const clock = manualDelay();
  const out = outbox(socket, clock.delay, { maxQueuedBytes: 4096 });
  out.packFrames();
  const closed = once(client, "close").then(([code]) => code);
  // Twenty deltas of ~400 bytes would sit under the 64 KiB frame limit, past the 4 KiB budget.
  for (let index = 0; index < 20; index++) out.send(delta("x".repeat(256)));
  expect(await closed).toBe(RESYNC_CLOSE_CODE);
});
