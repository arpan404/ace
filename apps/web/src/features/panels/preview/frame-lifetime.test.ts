import { FakeDaemon, ScenarioPlayer, failingSubagent, fakeTransport } from "@ace/fake-daemon";
import { BrowserState, DeviceId, ServerMessage } from "@ace/protocol";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Client, type OneWayMessage } from "@ace/client";
import { FrameFanout } from "@ace/browser";
import { memoryStorage } from "@/boot/client.ts";
import { daemonPreview } from "./daemon-preview.ts";
import type { DecodedFrame } from "./frames.ts";

const ignoreMessage = () => {};
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function setup() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("test-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
    random: () => 0.5,
    id: () => `id-${++ids}`,
    scheduler: {
      set(delay, work) {
        const timer = setTimeout(work, delay);
        return () => clearTimeout(timer);
      },
    },
  });
  clients.push(client);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  let receive: (message: ServerMessage) => void = ignoreMessage;
  let quiet = false;
  const onMessage = client.onMessage.bind(client);
  client.onMessage = (listener) => {
    receive = listener;
    return onMessage((message) => {
      if (!quiet || (message.type !== "browser.frame" && message.type !== "browser.state"))
        listener(message);
    });
  };
  const sent: OneWayMessage[] = [];
  const send = client.send.bind(client);
  client.send = (message) => {
    sent.push(message);
    send(message);
  };
  const decodes = new Map<string, ReturnType<typeof Promise.withResolvers<DecodedFrame>>>();
  const released: string[] = [];
  const source = daemonPreview(client, {
    schedule: () => () => {},
    visibility: { visible: () => true, watch: () => () => {} },
    decode: (data) => {
      if (!data.startsWith("pending-")) return Promise.resolve({ src: data, release() {} });
      const decode = Promise.withResolvers<DecodedFrame>();
      decodes.set(data, decode);
      return decode.promise;
    },
  });
  const threadId = "thread-settings";
  const stop = source.watch(threadId);
  await source.open(threadId, failingSubagent().thread.workspaceId);
  await waitFor(() => expect(source.frame(threadId)).toBeDefined());
  const frame = (data: string, sequence = 100) =>
    receive(
      ServerMessage.parse({
        type: "browser.frame",
        threadId,
        frame: { data, sequence, timestamp: 1000, width: 100, height: 100 },
      }),
    );
  const finish = async (data: string, failed = false) => {
    const decode = decodes.get(data);
    if (!decode) throw new Error("No pending decode");
    if (failed) decode.reject(new Error("decode failed"));
    else
      decode.resolve({
        src: data,
        release: () => {
          released.push(data);
        },
      });
    await Promise.resolve();
  };
  return {
    source,
    client,
    threadId,
    stop,
    frame,
    finish,
    sent,
    released,
    receive,
    quiet: () => {
      quiet = true;
    },
    decoding: (data: string) => decodes.has(data),
  };
}

test.each(["local close", "remote close", "unwatch", "disconnect"])(
  "%s fences a late frame with the same sequence as the replacement",
  async (transition) => {
    const t = await setup();
    t.frame("pending-old");
    if (transition === "local close") {
      await t.source.close(t.threadId);
      await t.source.open(t.threadId, failingSubagent().thread.workspaceId);
    } else if (transition === "remote close") {
      t.receive({
        type: "browser.state",
        state: BrowserState.parse({
          threadId: t.threadId,
          url: "about:blank",
          controller: "none",
          closed: true,
        }),
      });
      t.receive({
        type: "browser.state",
        state: BrowserState.parse({
          threadId: t.threadId,
          url: "about:blank",
          controller: "agent",
          closed: false,
        }),
      });
    } else if (transition === "unwatch") {
      t.stop();
      await Promise.resolve();
      t.source.watch(t.threadId);
    } else {
      t.client.networkOnline(false);
      t.client.networkOnline(true);
      await waitFor(() => expect(t.client.state).toBe("ready"));
    }
    await t.client.request({ type: "browser.origins.list", threadId: t.threadId });
    await Promise.resolve();
    t.frame("pending-new");
    await t.finish("pending-new");
    const acks = t.sent.filter((message) => message.type === "browser.ack").length;
    await t.finish("pending-old");
    expect(t.source.frame(t.threadId)?.src).toBe("pending-new");
    expect(t.released).toContain("pending-old");
    expect(t.released).not.toContain("pending-new");
    expect(t.sent.filter((message) => message.type === "browser.ack")).toHaveLength(acks);
  },
);

test("an obsolete decode failure cannot acknowledge the replacement browser's frame", async () => {
  const t = await setup();
  t.frame("pending-old");
  await t.source.close(t.threadId);
  await t.source.open(t.threadId, failingSubagent().thread.workspaceId);
  await t.client.request({ type: "browser.origins.list", threadId: t.threadId });
  await Promise.resolve();
  t.frame("pending-new");
  const acks = t.sent.filter((message) => message.type === "browser.ack").length;
  await t.finish("pending-old", true);
  expect(t.sent.filter((message) => message.type === "browser.ack")).toHaveLength(acks);
  await t.finish("pending-new");
  expect(t.source.frame(t.threadId)?.src).toBe("pending-new");
  expect(t.sent.at(-1)).toMatchObject({ type: "browser.ack", sequence: 100 });
});

test.each(["backend replacement", "recovery"])(
  "a frame delivered before %s state is replayed and later frames keep flowing",
  async (transition) => {
    const t = await setup();
    t.quiet();
    const state = BrowserState.parse({
      threadId: t.threadId,
      url: "about:blank",
      controller: "agent",
      closed: false,
      backend: transition === "backend replacement" ? "embedded" : "headless",
      status: "ready",
    });
    t.receive({ type: "browser.state", state });
    t.stop();
    await t.client.request({ type: "browser.origins.list", threadId: t.threadId });
    const fanout = new FrameFanout();
    const publish = (sequence: number, data: string) =>
      fanout.publish({
        sequence,
        data,
        timestamp: 1000,
        width: 100,
        height: 100,
      });
    publish(100, "pending-before-state");
    const replayStarted = Promise.withResolvers<void>();
    const resumeReplay = Promise.withResolvers<void>();
    let subscribed = false;
    let stopFrames = ignoreMessage;
    const request = t.client.request.bind(t.client);
    t.client.request = async (input, options) => {
      if (input.type === "browser.subscribe" && subscribed) {
        replayStarted.resolve();
        await resumeReplay.promise;
      }
      const result = await request(input, options);
      if (input.type === "browser.subscribe") {
        subscribed = true;
        stopFrames();
        stopFrames = fanout.subscribe("viewer", {
          send: (frame) => {
            t.receive({ type: "browser.frame", threadId: state.threadId, frame });
            return true;
          },
        });
        // This is the production initial subscription/recovery order.
        t.receive({
          type: "browser.state",
          state: {
            ...state,
            backend: "headless",
            status: transition === "recovery" ? "recovering" : "ready",
          },
        });
      }
      return result;
    };
    const send = t.client.send.bind(t.client);
    t.client.send = (message) => {
      if (message.type === "browser.ack") fanout.acknowledge("viewer", message.sequence);
      else send(message);
    };
    const stop = t.source.watch(t.threadId);
    try {
      await replayStarted.promise;
      await t.finish("pending-before-state");
      expect(t.released).toContain("pending-before-state");
      publish(101, "pending-replayed");
      resumeReplay.resolve();
      await waitFor(() => expect(t.decoding("pending-replayed")).toBe(true));
      await t.finish("pending-replayed");
      expect(t.source.frame(t.threadId)?.src).toBe("pending-replayed");
      publish(102, "pending-following");
      await waitFor(() => expect(t.decoding("pending-following")).toBe(true));
      await t.finish("pending-following");
      expect(t.source.frame(t.threadId)?.src).toBe("pending-following");
    } finally {
      resumeReplay.resolve();
      stopFrames();
      stop();
    }
  },
);
