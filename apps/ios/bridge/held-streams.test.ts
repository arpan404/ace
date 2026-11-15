import type { MediaRoute } from "@ace/browser/live-view";
import { ScreenStreamClient } from "@ace/client/screen-stream";
import { ScreenState, ServerMessage, type MediaStreamClientMessage } from "@ace/protocol";
import { expect, test } from "vitest";
import { HeldStreams } from "./held-streams.ts";

/*
 * A Mac app's live view on the phone through the shared screen client: Swift holds the stream,
 * acknowledges what it decoded and falls back to H.264, and the client sends each where it
 * belongs. The channel is a fake daemon that binds every subscribe naming a media connection.
 */

const state = ScreenState.parse({
  sessionId: "app",
  lifecycle: "live",
  controller: "none",
  indicator: false,
  target: { kind: "app", bundleId: "com.apple.calculator" },
  permissions: { screenRecording: true, accessibility: true },
});

function phone(bound: string | undefined, binds = false) {
  let connection = bound;
  const watchers = new Set<() => void>();
  const carried: MediaStreamClientMessage[] = [];
  const route: MediaRoute = {
    binding: () => (connection ? { connection } : undefined),
    codecs: () => ["hvc1.1.6.L153.B0", "avc1.42E033"],
    watch: (listener) => {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    onStream: () => () => {},
    ack: (message) => {
      if (!connection) return false;
      carried.push(message);
      return true;
    },
  };
  const sent: { type: string; operation?: Record<string, unknown> }[] = [];
  let events: Parameters<Parameters<ScreenStreamClient["connect"]>[0]["open"]>[0] | undefined;
  let ids = 0;
  const client = new ScreenStreamClient({ id: () => `r${++ids}`, schedule: () => () => {} });
  client.connect({
    open: (handlers) => void (events = handlers),
    send: (message) => {
      sent.push(message as (typeof sent)[number]);
      if (message.type !== "screen.request") return;
      const { requestId, operation } = message;
      const media = operation.op === "subscribe" ? operation.media : undefined;
      queueMicrotask(() =>
        events?.message(
          ServerMessage.parse({
            type: "screen.result",
            requestId,
            ok: true,
            // As D1 serves screens today: the subscribe may name the connection, and the daemon
            // answers without `media`, keeping the pictures on the channel.
            ...(media && binds ? { media } : {}),
          }),
        ),
      );
    },
    close: () => {},
  });
  events?.ready();
  events?.message(ServerMessage.parse({ type: "screen.state", state }));
  const streams = new HeldStreams(client);
  streams.useMedia(route);
  return {
    streams,
    carried,
    sent,
    subscribes: () => sent.flatMap((m) => (m.operation?.op === "subscribe" ? [m.operation] : [])),
    channelAcks: () => sent.filter((m) => m.type === "screen.ack"),
    move(next: string | undefined) {
      connection = next;
      for (const watcher of Array.from(watchers)) watcher();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("a held app names the media connection; served on the channel, its pictures are acked there", async () => {
  const app = phone("mc_aaaaaaaa");
  app.streams.hold("app");
  await settle();
  expect(app.subscribes()).toEqual([
    {
      op: "subscribe",
      sessionId: "app",
      media: { connection: "mc_aaaaaaaa" },
      codecs: ["hvc1.1.6.L153.B0", "avc1.42E033"],
    },
  ]);
  app.streams.ack("app", "capture-1", 5, true);
  expect(app.channelAcks()).toEqual([
    { type: "screen.ack", sessionId: "app", streamId: "capture-1", sequence: 5, keyframe: true },
  ]);
  expect(app.carried).toEqual([]);
});

test("without a media connection the app is subscribed and acked on its channel", async () => {
  const app = phone(undefined);
  app.streams.hold("app");
  await settle();
  expect(app.subscribes()).toEqual([{ op: "subscribe", sessionId: "app" }]);
  app.streams.ack("app", "capture-1", 2, false);
  expect(app.channelAcks()).toEqual([
    { type: "screen.ack", sessionId: "app", streamId: "capture-1", sequence: 2 },
  ]);
  expect(app.carried).toEqual([]);
});

test("one view whose decoder can't play HEVC asks again without it; the other keeps it", async () => {
  const app = phone("mc_aaaaaaaa");
  app.streams.hold("app");
  app.streams.hold("other");
  await settle();
  app.streams.fallBack("app", "hvc1.1.6.L153.B0");
  await settle();
  expect(app.subscribes().slice(2)).toEqual([
    {
      op: "subscribe",
      sessionId: "app",
      media: { connection: "mc_aaaaaaaa" },
      codecs: ["avc1.42E033"],
    },
  ]);
  // The other app's next subscribe still names HEVC first.
  app.streams.hold("other");
  await settle();
  expect(app.subscribes().at(-1)).toMatchObject({
    sessionId: "other",
    codecs: ["hvc1.1.6.L153.B0", "avc1.42E033"],
  });
});

test("Swift asking for a held app again subscribes it again; releasing it ends it", async () => {
  const app = phone("mc_aaaaaaaa");
  app.streams.hold("app");
  app.streams.hold("app");
  await settle();
  expect(app.subscribes()).toHaveLength(2);
  app.streams.release("app");
  expect(app.sent.at(-1)?.operation).toEqual({ op: "unsubscribe", sessionId: "app" });
  app.move("mc_bbbbbbbb");
  await settle();
  // A released app isn't subscribed again when the binding changes.
  expect(app.subscribes()).toHaveLength(2);
});
