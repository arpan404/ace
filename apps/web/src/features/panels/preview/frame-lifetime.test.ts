import { FakeDaemon, ScenarioPlayer, failingSubagent, fakeTransport } from "@ace/fake-daemon";
import { BrowserState, DeviceId, ServerMessage } from "@ace/protocol";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Client, type OneWayMessage } from "@ace/client";
import { memoryStorage } from "@/boot/client.ts";
import { daemonPreview } from "./daemon-preview.ts";
import { heldDecoder, playsH264 } from "./video-test-support.ts";

const ignoreMessage = () => {};
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/**
 * A preview over the fake daemon's video, with a decoder that holds every chunk until the test
 * lets it out, so a picture can land after its stream started over.
 */
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
      if (!quiet || message.type !== "browser.state") listener(message);
    });
  };
  const sent: OneWayMessage[] = [];
  const send = client.send.bind(client);
  client.send = (message) => {
    sent.push(message);
    send(message);
  };
  const decoder = heldDecoder();
  let visible = true;
  /** The view's next retry, fired by hand. */
  let retry: (() => void) | undefined;
  const source = daemonPreview(client, {
    schedule: (callback) => {
      retry = callback;
      return () => {
        if (retry === callback) retry = undefined;
      };
    },
    visibility: { visible: () => visible, watch: () => () => {} },
    videoDecoder: decoder.factory,
    videoSupport: playsH264,
  });
  const threadId = "thread-settings";
  const stop = source.watch(threadId);
  await source.open(threadId, failingSubagent().thread.workspaceId);
  await waitFor(() => expect(decoder.decoders.at(-1)?.pending.length).toBe(1));
  const acks = () => sent.filter((message) => message.type === "browser.ack");
  return {
    daemon,
    source,
    client,
    threadId,
    stop,
    decoder,
    acks,
    receive,
    hide: () => {
      visible = false;
    },
    retry: () => retry?.(),
    quiet: () => {
      quiet = true;
    },
  };
}

test.each(["paused", "recovering", "backend replacement"])(
  "removing the last watcher while hidden after %s leaves room for eight later previews",
  async (transition) => {
    const t = await setup();
    t.decoder.decoders.at(-1)?.flush();
    await t.client.request({ type: "browser.tabs.list", threadId: t.threadId });
    const previous = t.source.view(t.threadId);
    t.quiet();
    t.hide();
    t.receive({
      type: "browser.state",
      state: BrowserState.parse({
        threadId: t.threadId,
        url: "about:blank",
        controller: "agent",
        closed: false,
        activeTabId: previous?.activeTabId,
        backend:
          transition === "backend replacement"
            ? previous?.backend === "embedded"
              ? "headless"
              : "embedded"
            : previous?.backend,
        status: transition === "backend replacement" ? "ready" : transition,
      }),
    });
    // The page's last picture stays while its stream starts over.
    expect(t.source.frame(t.threadId)).toBeDefined();
    t.stop();
    // Drain last-watcher cleanup through the real client/daemon connection.
    await Promise.resolve();
    await t.client.request({ type: "browser.tabs.list", threadId: t.threadId });

    // An abandoned subscription consumes one of the daemon's eight slots. All eight
    // later previews must be admitted without a reconnect or detaching the client.
    for (let index = 0; index < 8; index++) {
      const threadId = `later-preview-${index}`;
      t.daemon.createThread(failingSubagent(threadId).thread);
      t.daemon.browser.drive(threadId, { url: "about:blank" });
      const reply = await t.client.request({ type: "browser.subscribe", threadId });
      expect(reply.ok).toBe(true);
    }
  },
);

test.each(["local close", "remote close", "unwatch", "disconnect"])(
  "after %s, a picture the old stream's decoder still held is freed unshown and never acked",
  async (transition) => {
    const t = await setup();
    const old = t.decoder.decoders.at(-1);
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
      // The view asks again on its next retry.
      t.retry();
    } else if (transition === "unwatch") {
      t.stop();
      await Promise.resolve();
      t.source.watch(t.threadId);
    } else {
      t.client.networkOnline(false);
      t.client.networkOnline(true);
      await waitFor(() => expect(t.client.state).toBe("ready"));
    }
    // The new stream starts from a keyframe in a new decoder.
    await waitFor(() => {
      expect(t.decoder.decoders.at(-1)).not.toBe(old);
      expect(t.decoder.decoders.at(-1)?.pending.length).toBeGreaterThan(0);
    });
    // Whatever else the reopened browser says has arrived.
    await t.client.request({ type: "browser.tabs.list", threadId: t.threadId });
    const current = t.decoder.decoders.at(-1);
    const before = t.acks().length;
    old?.flush();
    expect(t.decoder.pictures.at(-1)?.closed).toBe(true);
    expect(t.source.frame(t.threadId)).toBeUndefined();
    expect(t.acks()).toHaveLength(before);
    current?.flush();
    // (The fixture sends its current picture again on each subscribe; one of them shows.)
    const shown = t.decoder.pictures.findLast((picture) => !picture.closed);
    expect(shown).toBeDefined();
    expect(t.source.frame(t.threadId)?.sequence).toBe(shown?.sequence);
    expect(t.acks().at(-1)).toMatchObject({ sequence: shown?.sequence, video: true });
  },
);

test("an old stream's decode error can't ask the new stream for a keyframe", async () => {
  const t = await setup();
  const old = t.decoder.decoders.at(-1);
  await t.source.close(t.threadId);
  await t.source.open(t.threadId, failingSubagent().thread.workspaceId);
  await waitFor(() => expect(t.decoder.decoders.at(-1)).not.toBe(old));
  const before = t.acks().length;
  old?.fail();
  expect(t.acks()).toHaveLength(before);
  t.decoder.decoders.at(-1)?.flush();
  expect(t.acks().at(-1)).toMatchObject({ video: true });
  expect(t.acks().at(-1)).not.toHaveProperty("keyframe");
});

test.each(["backend replacement", "recovery"])(
  "after %s, the view subscribes again and the page's pictures keep flowing",
  async (transition) => {
    const t = await setup();
    t.decoder.decoders.at(-1)?.flush();
    const previous = t.source.view(t.threadId);
    const decodersBefore = t.decoder.decoders.length;
    t.receive({
      type: "browser.state",
      state: BrowserState.parse({
        threadId: t.threadId,
        url: previous?.url ?? "about:blank",
        controller: "agent",
        closed: false,
        activeTabId: previous?.activeTabId,
        backend:
          transition === "backend replacement"
            ? previous?.backend === "embedded"
              ? "headless"
              : "embedded"
            : previous?.backend,
        status: transition === "recovery" ? "recovering" : "ready",
      }),
    });
    // The new subscription's first keyframe goes to a new decoder.
    await waitFor(() => expect(t.decoder.decoders.length).toBeGreaterThan(decodersBefore));
    t.decoder.decoders.at(-1)?.flush();
    t.daemon.browser.type(t.threadId, "after the restart");
    const latest = t.daemon.browser.frame(t.threadId)?.sequence;
    await waitFor(() => {
      t.decoder.decoders.at(-1)?.flush();
      expect(t.source.frame(t.threadId)?.sequence).toBe(latest);
    });
  },
);
