// A process test: the screen channel's client against the real screen bridge, over the fake
// screen helper process, with the daemon's delivery stood in by `@ace/media`'s shared fake. The
// edge a unit test can't reach is the bridge's own transactional resubscribe (D1): what it keeps
// delivering, and on which view, when a resubscribe fails after its view was granted.
import { afterEach, expect, it } from "vitest";
import { screenConnection, Simulators } from "@ace/screen";
import { manager, ready } from "@ace/screen/testing/support";
import { fakeDelivery, phoneOwner } from "@ace/media/testing/fake-delivery";
import type { MediaStreamClientMessage, ScreenServerMessage } from "@ace/protocol";
import type { StreamMessage } from "@ace/browser/stream";
import { ScreenStreamClient, type MediaRoute, type SourcePicture } from "./screen-stream.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const connection = "mc_aaaaaaaaaaaa";

it("a resubscribe that fails keeps the view the daemon regranted, and acks follow it", async () => {
  const test = await manager({ FAKE_V2: "1" });
  cleanups.push(test.close);
  const state = await ready(test.screen);
  const delivery = fakeDelivery();
  /** Fails the bridge's subscribe after its view was granted (as D1's own test does). */
  const failing = { on: false };
  let events: Parameters<Parameters<ScreenStreamClient["connect"]>[0]["open"]>[0] | undefined;
  const results: ScreenServerMessage[] = [];
  const bridge = screenConnection(test.screen, new Simulators("linux"), "human-1", {
    send: (message) => {
      results.push(message);
      void events?.message(message);
    },
    delivery: { owner: () => phoneOwner, port: () => delivery.port },
    acceleration: {
      for: () => {
        if (failing.on) throw new Error("acceleration store gone");
        return undefined;
      },
      watch: () => () => {},
    },
  });
  cleanups.push(async () => bridge.close());
  let ids = 0;
  const client = new ScreenStreamClient({ id: () => `r${++ids}`, schedule: () => () => {} });
  client.connect({
    open: (handlers) => {
      events = handlers;
      handlers.ready();
    },
    send: (message) =>
      message.type === "screen.ack" ? bridge.ack(message) : bridge.request(message),
    close: () => {},
  });
  // ace-media: delivers pictures for the views it holds live on this connection, and nothing else.
  const streams = new Set<(message: StreamMessage) => void>();
  const mediaAcks: MediaStreamClientMessage[] = [];
  const route: MediaRoute = {
    binding: () => ({ connection }),
    codecs: () => ["hvc1.1.6.L153.B0", "avc1.42E033"],
    watch: () => () => {},
    onStream: (listener) => {
      streams.add(listener);
      return () => void streams.delete(listener);
    },
    ack: (message) => {
      mediaAcks.push(message);
      return true;
    },
  };
  const aceMedia = (sequence: number) => {
    const live = [...delivery.live].some(
      (viewer) => delivery.views.get(viewer)?.connection === connection,
    );
    if (!live) return;
    for (const listener of streams)
      listener({
        kind: "screen.frame",
        sourceId: state.sessionId,
        frame: {
          sequence,
          timestamp: sequence,
          width: 4,
          height: 2,
          scale: 1,
          rotation: 0,
          codec: "hvc1.1.6.L153.B0",
          key: true,
          streamId: "capture-1",
          bytes: Uint8Array.of(0, 0, 0, 1, 0x40),
        },
      });
  };
  client.useMedia(route);
  await client.request({ op: "sessions" });
  const drawn: SourcePicture[] = [];
  client.watchPictures(state.sessionId, async (picture) => {
    drawn.push(picture);
    client.ack(picture);
  });
  client.retainStream(state.sessionId);
  await expect.poll(() => delivery.live.size).toBe(1);
  const [first] = delivery.live;
  aceMedia(1);
  await expect.poll(() => drawn.map((picture) => picture.sequence)).toEqual([1]);

  // The view can't decode HEVC: the same connection is asked again, and the bridge fails it
  // after granting its new view, which replaced the old one in ace-media until it was undone.
  failing.on = true;
  client.fallBack(state.sessionId, "hvc1.1.6.L153.B0");
  await expect
    .poll(() => results.some((message) => message.type === "screen.result" && !message.ok))
    .toBe(true);
  failing.on = false;
  expect(delivery.views.size).toBe(1);
  expect([...delivery.live]).toEqual([first]);

  // The regranted view delivers again, and the client takes it as the delivery it kept.
  aceMedia(2);
  await expect.poll(() => drawn.map((picture) => picture.sequence)).toEqual([1, 2]);
  expect(mediaAcks.map((ack) => ack.type === "screen.ack" && ack.sequence)).toEqual([1, 2]);
});
