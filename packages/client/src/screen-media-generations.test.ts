import { describe, expect, it } from "vitest";
import { ScreenState, ServerMessage, type MediaStreamClientMessage } from "@ace/protocol";
import { encodePicture, streamKinds, type StreamMessage } from "@ace/browser/stream";
import { ScreenStreamClient, type MediaRoute, type SourcePicture } from "./screen-stream.ts";

/*
 * A media binding changing under a live screen stream (a reconnect, a new connection id): what
 * belongs to the old subscribe, or came by the old connection, never steers or reaches the new.
 */

const state = ScreenState.parse({
  sessionId: "app",
  lifecycle: "live",
  controller: "none",
  indicator: false,
  target: { kind: "app", bundleId: "com.apple.calculator" },
  permissions: { screenRecording: true, accessibility: true },
});

const frame = (sequence: number): StreamMessage => ({
  kind: "screen.frame",
  sourceId: "app",
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

type Subscribe = { requestId: string; media?: { connection: string } };

function harness(draw?: (picture: SourcePicture) => Promise<void>) {
  const subscribes: Subscribe[] = [];
  const channelAcks: unknown[] = [];
  let events: Parameters<Parameters<ScreenStreamClient["connect"]>[0]["open"]>[0] | undefined;
  let ids = 0;
  const client = new ScreenStreamClient({ id: () => `r${++ids}`, schedule: () => () => {} });
  client.connect({
    open: (handlers) => void (events = handlers),
    send: (message) => {
      if (message.type === "screen.ack") return void channelAcks.push(message);
      if (message.type === "screen.request" && message.operation.op === "subscribe")
        subscribes.push({
          requestId: message.requestId,
          ...(message.operation.media ? { media: message.operation.media } : {}),
        });
    },
    close: () => {},
  });
  events!.ready();
  const server = (message: unknown) => events!.message(ServerMessage.parse(message));
  /** A picture on the screen channel itself (legacy delivery). */
  const onChannel = (message: StreamMessage) => {
    if (message.kind !== "screen.frame") return;
    const { bytes, ...header } = message.frame;
    for (const piece of encodePicture(
      streamKinds.screenFrame,
      message.frame.sequence,
      "app",
      header,
      bytes,
    ))
      events!.message(piece);
  };
  server({ type: "screen.state", state });
  let connection: string | undefined = "mc_aaaaaaaaaa";
  const watchers = new Set<() => void>();
  const streams = new Set<(message: StreamMessage) => void>();
  const mediaAcks: { on: string | undefined; message: MediaStreamClientMessage }[] = [];
  const route: MediaRoute = {
    binding: () => (connection ? { connection } : undefined),
    codecs: () => ["hvc1.1.6.L153.B0", "avc1.42E033"],
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
      mediaAcks.push({ on: connection, message });
      return true;
    },
  };
  client.useMedia(route);
  const drawn: SourcePicture[] = [];
  client.watchPictures("app", async (picture) => {
    drawn.push(picture);
    await draw?.(picture);
  });
  return {
    client,
    subscribes,
    channelAcks,
    mediaAcks,
    drawn,
    move(next: string | undefined) {
      connection = next;
      for (const watcher of watchers) watcher();
    },
    onChannel,
    deliver(message: StreamMessage) {
      for (const listener of streams) listener(message);
    },
    reply(subscribe: Subscribe, answer: "binds" | "refuses") {
      server(
        answer === "refuses"
          ? {
              type: "screen.result",
              requestId: subscribe.requestId,
              ok: false,
              error: "media-connection: that media connection isn't this session's",
            }
          : {
              type: "screen.result",
              requestId: subscribe.requestId,
              ok: true,
              ...(subscribe.media ? { media: subscribe.media } : {}),
            },
      );
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("screen pictures across a media rebind", () => {
  it("the old subscribe's late reply leaves the new subscribe's delivery alone", async () => {
    const view = harness();
    view.client.retainStream("app");
    view.move("mc_bbbbbbbbbb");
    const [first, second] = view.subscribes;
    expect(second?.media).toEqual({ connection: "mc_bbbbbbbbbb" });
    view.reply(first!, "binds");
    view.reply(second!, "binds");
    await flush();
    view.deliver(frame(1));
    await flush();
    view.client.ack(view.drawn[0]!);
    expect(view.mediaAcks.map((ack) => ack.on)).toEqual(["mc_bbbbbbbbbb"]);
    expect(view.channelAcks).toEqual([]);
  });

  it("the old subscribe's refusal neither marks the new connection refused nor subscribes again", async () => {
    const view = harness();
    view.client.retainStream("app");
    view.move("mc_bbbbbbbbbb");
    const [first, second] = view.subscribes;
    view.reply(first!, "refuses");
    await flush();
    expect(view.subscribes).toHaveLength(2);
    view.reply(second!, "binds");
    await flush();
    view.deliver(frame(1));
    await flush();
    view.client.ack(view.drawn[0]!);
    expect(view.mediaAcks.map((ack) => ack.on)).toEqual(["mc_bbbbbbbbbb"]);
  });

  it("a picture from the old connection is neither drawn after the rebind nor acked through the new one", async () => {
    let release: (() => void) | undefined;
    const view = harness(
      (picture) =>
        new Promise<void>((done) => {
          if (picture.sequence === 1) release = done;
          else done();
        }),
    );
    view.client.retainStream("app");
    view.reply(view.subscribes[0]!, "binds");
    await flush();
    // Picture 1 is drawing; picture 2 waits behind it in the queue.
    view.deliver(frame(1));
    view.deliver(frame(2));
    await flush();
    view.move("mc_bbbbbbbbbb");
    view.reply(view.subscribes[1]!, "binds");
    await flush();
    release?.();
    await flush();
    // The draw that was under way finishes and acks: that ack belongs to the old connection.
    view.client.ack(view.drawn[0]!);
    expect(view.drawn.map((picture) => picture.sequence)).toEqual([1]);
    expect(view.mediaAcks).toEqual([]);
    expect(view.channelAcks).toEqual([]);
    expect(view.client.current(view.drawn[0]!)).toBe(false);
    // The new connection's pictures draw and ack through it.
    view.deliver(frame(3));
    await flush();
    view.client.ack(view.drawn.at(-1)!);
    expect(view.drawn.map((picture) => picture.sequence)).toEqual([1, 3]);
    expect(view.mediaAcks.map((ack) => ack.on)).toEqual(["mc_bbbbbbbbbb"]);
  });

  it("pictures that come on the channel while a media subscribe is pending aren't drawn", async () => {
    const view = harness();
    view.move(undefined);
    view.client.retainStream("app");
    view.reply(view.subscribes[0]!, "binds");
    await flush();
    view.move("mc_bbbbbbbbbb");
    // Still from the channel subscription: it isn't what the new subscribe asked for.
    view.onChannel(frame(5));
    await flush();
    expect(view.drawn).toEqual([]);
  });
});
