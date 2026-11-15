import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ThreadId, type MediaStreamClientMessage, type MediaPoster } from "@ace/protocol";
import type { ClientApi, StreamMessage } from "@ace/client";
import { fakeClient } from "@/test/fake-client.ts";
import { daemonPreview, type PreviewMedia } from "./daemon-preview.ts";
import type { PosterDecoder } from "@/lib/video/poster.ts";
import { mediaSubscribeDeadlineMs } from "@ace/browser/live-view";
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
/**
 * How the daemon answers a subscribe naming a connection. `replays here` serves it on the socket
 * as `serves here` does, but first replays the page's last picture (a keyframe) on the socket,
 * before the reply, as the browser bridge does.
 */
type Daemon =
  | "binds"
  | "answers later"
  | "serves here"
  | "replays here"
  | "replays, answers later"
  | "refuses";

function withMediaReplies(
  api: ClientApi,
  poster: MediaPoster | undefined,
  daemon: Daemon,
  refused: unknown[],
  replay: () => void,
  answered: Promise<void>,
) {
  return new Proxy(api, {
    get(target, key) {
      if (key === "request")
        return async (input: Parameters<ClientApi["request"]>[0], options?: object) => {
          const named =
            input.type === "browser.subscribe" && "media" in input ? input.media : undefined;
          if (named && daemon === "refuses") {
            refused.push(input);
            return {
              type: "browser.result",
              requestId: "r",
              ok: false,
              error: "media-connection: that media connection isn't this session's",
            };
          }
          const reply = await target.request(input, options);
          if (named && (daemon === "replays here" || daemon === "replays, answers later")) replay();
          if (named && (daemon === "replays, answers later" || daemon === "answers later"))
            await answered;
          if (
            input.type !== "browser.subscribe" ||
            !named ||
            daemon === "serves here" ||
            daemon === "replays here" ||
            daemon === "replays, answers later"
          )
            return reply;
          return {
            ...reply,
            media: { connection: named.connection, ...(poster ? { poster } : {}) },
          };
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function watching(
  initial: string | undefined,
  poster?: MediaPoster,
  answer: Daemon = "binds",
  decodePoster?: PosterDecoder,
) {
  /** The view's timers, fired by the test (`fire`) by their delay. */
  const timers = new Set<{ run: () => void; ms: number }>();
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
  const refused: unknown[] = [];
  let answerNow: (() => void) | undefined;
  let replays = 0;
  const answered = new Promise<void>((resolve) => (answerNow = resolve));
  const preview = daemonPreview(
    withMediaReplies(
      wire.api,
      poster,
      answer,
      refused,
      // Each replay a later number, so a test can tell which subscribe's it was.
      () => wire.stream(video(++replays, true)),
      answered,
    ),
    {
      schedule: (run, ms) => {
        const timer = { run, ms };
        timers.add(timer);
        return () => void timers.delete(timer);
      },
      visibility: { visible: () => true, watch: () => () => {} },
      videoDecoder: decoder.factory,
      videoSupport: () => Promise.resolve(["hvc1.1.6.L153.B0", "avc1.42E033"]),
      media: link.media,
      poster: async (shown) => {
        posters.push(shown);
        return decodePoster ? decodePoster(shown) : { sequence: -1, draw() {}, close() {} };
      },
    },
  );
  const stop = preview.watch(thread);
  let watched = true;
  const unwatch = () => {
    if (watched) stop();
    watched = false;
  };
  disposers.push(() => {
    unwatch();
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
  return {
    preview,
    wire,
    link,
    subscribes,
    mainAcks,
    posters,
    daemon,
    refused,
    unwatch,
    answer: () => answerNow?.(),
    /** Every timer of this delay runs. */
    fire(ms: number) {
      for (const timer of Array.from(timers))
        if (timer.ms === ms) {
          timers.delete(timer);
          timer.run();
        }
    },
  };
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

test("acks stay on the socket when the daemon serves the video there itself", async () => {
  const { wire, link, subscribes, mainAcks } = await watching(
    "mc_aaaaaaaaaa",
    undefined,
    "serves here",
  );
  expect(subscribes()[0]).toMatchObject({ media: { connection: "mc_aaaaaaaaaa" } });
  wire.stream(video(1, true));
  await waitFor(() => expect(mainAcks()).toHaveLength(1));
  expect(link.acks).toEqual([]);
});

test("a refused connection subscribes again on the socket", async () => {
  const { subscribes, refused } = await watching("mc_aaaaaaaaaa", undefined, "refuses");
  expect(refused).toEqual([expect.objectContaining({ media: { connection: "mc_aaaaaaaaaa" } })]);
  // The one the daemon took names no connection.
  expect(subscribes()).toHaveLength(1);
  expect(subscribes()[0]).not.toHaveProperty("media");
});

test("video that still comes on the socket after the view moved to the media connection is dropped", async () => {
  const { preview, wire, link, mainAcks } = await watching("mc_aaaaaaaaaa");
  // The socket's subscription from before: neither drawn nor acked anywhere.
  wire.stream(video(1, true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(preview.frame(thread)).toBeUndefined();
  expect(mainAcks()).toEqual([]);
  expect(link.acks).toEqual([]);
  link.deliver(video(2, true));
  await waitFor(() => expect(preview.frame(thread)?.sequence).toBe(2));
});

test("a page's last picture replayed on the socket before the reply shows once the reply settles there", async () => {
  const { preview, link, mainAcks } = await watching("mc_aaaaaaaaaa", undefined, "replays here");
  // The page is static: nothing follows the replayed keyframe.
  await waitFor(() => expect(preview.frame(thread)?.sequence).toBe(1));
  await waitFor(() => expect(mainAcks()).toContainEqual(expect.objectContaining({ sequence: 1 })));
  expect(link.acks).toEqual([]);
});

test("pictures held for a pending subscribe die with the view: its late reply shows and acks nothing", async () => {
  const view = await watching("mc_aaaaaaaaaa", undefined, "replays, answers later");
  // The replayed keyframe is held while the reply is pending; then nobody watches any more.
  view.unwatch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.answer();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.mainAcks()).toEqual([]);
  expect(view.link.acks).toEqual([]);
});

test("a disposed view's pending subscribe leaves nothing behind when its reply comes", async () => {
  const view = await watching("mc_aaaaaaaaaa", undefined, "replays, answers later");
  view.preview.dispose();
  view.answer();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.mainAcks()).toEqual([]);
  expect(view.preview.frame(thread)).toBeUndefined();
});

test("the reply of a subscribe a rebind replaced never shows the picture held for it", async () => {
  const view = await watching("mc_aaaaaaaaaa", undefined, "replays, answers later");
  // Replay 1 is held for the subscribe naming A; the connection moves before its reply comes.
  view.link.move("mc_bbbbbbbbbb");
  view.answer();
  // The subscribe again (naming B) gets replay 2, and only that one is the view's.
  await waitFor(() => expect(view.preview.frame(thread)?.sequence).toBe(2));
  expect(view.mainAcks()).not.toContainEqual(expect.objectContaining({ sequence: 1 }));
});

test("a subscribe that times out stops holding video, and its late reply still settles delivery", async () => {
  const view = await watching("mc_aaaaaaaaaa", undefined, "answers later");
  // No answer in time: the video is the socket's until the daemon says otherwise.
  view.fire(mediaSubscribeDeadlineMs);
  view.wire.stream(video(1, true));
  await waitFor(() => expect(view.preview.frame(thread)?.sequence).toBe(1));
  await waitFor(() =>
    expect(view.mainAcks()).toContainEqual(expect.objectContaining({ sequence: 1 })),
  );
  // The answer comes late: the daemon delivers by the media connection after all.
  view.answer();
  await waitFor(() => expect(view.subscribes().length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  view.link.deliver(video(2, true));
  await waitFor(() => expect(view.preview.frame(thread)?.sequence).toBe(2));
  expect(view.link.acks).toContainEqual(expect.objectContaining({ sequence: 2 }));
});

test("a poster still decoding when the view rebinds is never drawn", async () => {
  const decodes: {
    resolve: (picture: { sequence: number; draw(): void; close(): void }) => void;
  }[] = [];
  const closed: number[] = [];
  const view = await watching(
    "mc_aaaaaaaaaa",
    { width: 1170, height: 2400, jpeg: "/9j/AA==" },
    "binds",
    () => new Promise((resolve) => decodes.push({ resolve })),
  );
  await waitFor(() => expect(decodes).toHaveLength(1));
  // The connection moves while poster A decodes; the subscribe naming B brings poster B.
  view.link.move("mc_bbbbbbbbbb");
  await waitFor(() => expect(decodes).toHaveLength(2));
  decodes[0]!.resolve({ sequence: -100, draw() {}, close: () => void closed.push(-100) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  decodes[1]!.resolve({ sequence: -200, draw() {}, close: () => void closed.push(-200) });
  await waitFor(() => expect(view.preview.frame(thread)?.sequence).toBe(-200));
  expect(closed).toContain(-100);
});
