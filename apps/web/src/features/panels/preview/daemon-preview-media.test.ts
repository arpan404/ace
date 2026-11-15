import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ThreadId, type MediaStreamClientMessage, type MediaPoster } from "@ace/protocol";
import type { ClientApi, StreamMessage } from "@ace/client";
import { fakeClient } from "@/test/fake-client.ts";
import { daemonPreview, type PreviewMedia } from "./daemon-preview.ts";
import { streamingClient } from "./stream-test-support.ts";
import { instantDecoder } from "./video-test-support.ts";
import { degradedSentence } from "@/lib/video/degraded.tsx";

const thread = "thread-settings";

/** A media connection the test opens, moves and feeds. */
function fakeMedia(initial: string | undefined) {
  let connection = initial;
  const watchers = new Set<() => void>();
  const streams = new Set<(message: StreamMessage) => void>();
  const acks: MediaStreamClientMessage[] = [];
  const media: PreviewMedia = {
    binding: () => (connection ? { connection } : undefined),
    settled: () => Promise.resolve(),
    watch: (listener) => {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    onStream: (listener) => {
      streams.add(listener);
      return () => void streams.delete(listener);
    },
    ack: (message) => {
      if (!connection) return false;
      acks.push(message);
      return true;
    },
  };
  return {
    media,
    acks,
    move(next: string | undefined) {
      connection = next;
      for (const watcher of watchers) watcher();
    },
    deliver(message: StreamMessage) {
      for (const listener of streams) listener(message);
    },
  };
}

const video = (sequence: number, key: boolean): StreamMessage => ({
  kind: "browser.video",
  threadId: ThreadId.parse(thread),
  chunk: {
    sequence,
    timestamp: 1000 + sequence,
    width: 390,
    height: 800,
    codedWidth: 1170,
    codedHeight: 2400,
    codec: "hvc1.1.6.L153.B0",
    key,
    bytes: new Uint8Array([sequence]),
  },
});

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** Adds `media` to the daemon's `browser.subscribe` replies, as a daemon delivering by ace-media does. */
function withMediaReplies(api: ClientApi, poster: MediaPoster | undefined) {
  return new Proxy(api, {
    get(target, key) {
      if (key === "request")
        return async (input: Parameters<ClientApi["request"]>[0], options?: object) => {
          const reply = await target.request(input, options);
          if (input.type !== "browser.subscribe" || !("media" in input) || !input.media)
            return reply;
          return { ...reply, media: { connection: input.media.connection, ...(poster ? { poster } : {}) } };
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function watching(initial: string | undefined, poster?: MediaPoster) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive(thread, { url: "http://localhost:5173" });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const wire = streamingClient(client);
  const link = fakeMedia(initial);
  const decoder = instantDecoder();
  const posters: MediaPoster[] = [];
  const preview = daemonPreview(withMediaReplies(wire.api, poster), {
    schedule: () => () => {},
    visibility: { visible: () => true, watch: () => () => {} },
    videoDecoder: decoder.factory,
    videoSupport: () => Promise.resolve(["hvc1.1.6.L153.B0", "avc1.42E033"]),
    media: link.media,
    poster: async (shown) => {
      posters.push(shown);
      return { sequence: -1, draw() {}, close() {} };
    },
  });
  const stop = preview.watch(thread);
  disposers.push(() => {
    stop();
    preview.dispose();
  });
  await preview.open(thread, failingSubagent().thread.workspaceId);
  const subscribes = () =>
    wire.requests.filter(
      (request): request is { type: "browser.subscribe"; media?: unknown } =>
        typeof request === "object" &&
        request !== null &&
        "type" in request &&
        request.type === "browser.subscribe",
    );
  await waitFor(() => expect(subscribes().length).toBeGreaterThan(0));
  const mainAcks = () =>
    wire.sent.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "browser.ack",
    );
  return { preview, wire, link, subscribes, mainAcks, posters, daemon };
}

test("the browser's video subscribes on the media connection, comes by it and is acked there", async () => {
  const { preview, link, subscribes, mainAcks } = await watching("mc_aaaaaaaaaa");
  expect(subscribes()[0]).toMatchObject({ media: { connection: "mc_aaaaaaaaaa" } });
  link.deliver(video(1, true));
  await waitFor(() => expect(preview.frame(thread)).toBeDefined());
  expect(link.acks).toContainEqual({
    type: "browser.ack",
    threadId: thread,
    sequence: 1,
    video: true,
  });
  expect(mainAcks()).toEqual([]);
});

test("legacy delivery keeps the subscribe and its acks on the client's socket", async () => {
  const { wire, link, subscribes, mainAcks } = await watching(undefined);
  expect(subscribes()[0]).not.toHaveProperty("media");
  wire.stream(video(1, true));
  await waitFor(() => expect(mainAcks()).toHaveLength(1));
  expect(mainAcks()[0]).toMatchObject({ type: "browser.ack", sequence: 1, video: true });
  expect(link.acks).toEqual([]);
});

test("a reconnected media connection gets a subscribe naming its new id", async () => {
  const { link, subscribes } = await watching("mc_aaaaaaaaaa");
  link.move("mc_bbbbbbbbbb");
  await waitFor(() =>
    expect(subscribes().at(-1)).toMatchObject({ media: { connection: "mc_bbbbbbbbbb" } }),
  );
});

test("the poster shows before video, and the first picture replaces it", async () => {
  const poster = { width: 1170, height: 2400, jpeg: "/9j/AA==" };
  const { preview, link, posters } = await watching("mc_aaaaaaaaaa", poster);
  await waitFor(() => expect(preview.frame(thread)).toBeDefined());
  expect(posters).toEqual([poster]);
  expect(preview.frame(thread)?.sequence).toBe(-1);
  link.deliver(video(1, true));
  await waitFor(() => expect(preview.frame(thread)?.sequence).toBe(1));
});

test("the browser's view carries the degraded sentence exactly while its video is degraded", async () => {
  const { preview, daemon } = await watching("mc_aaaaaaaaaa");
  const sentence = () => degradedSentence(preview.view(thread)?.acceleration);
  const reason = "Video runs on the processor here: this computer has no hardware video encoder.";
  const steps = [{ step: "encode", backend: "cpu", hardware: false, readbacks: 1, uploads: 0 }];
  daemon.browser.setAcceleration(thread, { steps, degraded: true, reason });
  await waitFor(() => expect(sentence()).toBe(reason));
  daemon.browser.setAcceleration(thread, { steps, degraded: false });
  await waitFor(() => expect(sentence()).toBeUndefined());
});
