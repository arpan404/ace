import { describe, expect, it } from "vitest";
import { ScreenState, ServerMessage, type MediaStreamClientMessage } from "@ace/protocol";
import { streamKinds, type StreamMessage } from "@ace/browser/stream";
import { encodePicture } from "@ace/browser/stream-encode";
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

const frame = (
  sequence: number,
  options: { key?: boolean; timestamp?: number; size?: number } = {},
): StreamMessage => ({
  kind: "screen.frame",
  sourceId: "app",
  frame: {
    sequence,
    timestamp: options.timestamp ?? sequence,
    width: 4,
    height: 2,
    scale: 1,
    rotation: 0,
    codec: "hvc1.1.6.L153.B0",
    key: options.key ?? true,
    streamId: "capture-1",
    bytes: new Uint8Array(options.size ?? 5),
  },
});

type Subscribe = { requestId: string; media?: { connection: string } };

function harness(draw?: (picture: SourcePicture) => Promise<void>) {
  const subscribes: Subscribe[] = [];
  const channelAcks: unknown[] = [];
  let events: Parameters<Parameters<ScreenStreamClient["connect"]>[0]["open"]>[0] | undefined;
  let ids = 0;
  /** Request deadlines, fired by the test (`timeOut`). */
  const deadlines = new Set<() => void>();
  const client = new ScreenStreamClient({
    id: () => `r${++ids}`,
    schedule: (run) => {
      deadlines.add(run);
      return () => void deadlines.delete(run);
    },
  });
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
    /** A message from the daemon on the channel. */
    server,
    /** Why the session's view gets no pictures now, as its view reads it. */
    why: () => client.undelivered("app"),
    /** Timers waiting on the injected clock (request deadlines, retries). */
    pendingTimers: () => deadlines.size,
    /** Every pending request's deadline passes. */
    timeOut() {
      for (const run of Array.from(deadlines)) {
        deadlines.delete(run);
        run();
      }
    },
    deliver(message: StreamMessage) {
      for (const listener of streams) listener(message);
    },
    /** `channel`: the daemon serves the stream on the channel itself (no `media` in the reply). */
    /** `fails`: a transient error, such as the daemon's pending-request limit. */
    reply(subscribe: Subscribe, answer: "binds" | "refuses" | "channel" | "fails") {
      server(
        answer === "refuses" || answer === "fails"
          ? {
              type: "screen.result",
              requestId: subscribe.requestId,
              ok: false,
              error:
                answer === "fails"
                  ? "Too many pending screen requests"
                  : "media-connection: that media connection isn't this session's",
            }
          : {
              type: "screen.result",
              requestId: subscribe.requestId,
              ok: true,
              ...(subscribe.media && answer === "binds" ? { media: subscribe.media } : {}),
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

  it("pictures the media connection sends before its reply show once it confirms them", async () => {
    const view = harness();
    view.client.retainStream("app");
    view.deliver(frame(1));
    view.deliver(frame(2, { key: false }));
    await flush();
    view.reply(view.subscribes[0]!, "binds");
    await flush();
    expect(view.drawn.map((picture) => picture.sequence)).toEqual([1, 2]);
  });

  it("past two seconds of waiting pictures it keeps the keyframe and asks for a fresh one", async () => {
    const view = harness();
    view.client.retainStream("app");
    view.deliver(frame(1, { timestamp: 1_000 }));
    view.deliver(frame(2, { key: false, timestamp: 2_000 }));
    view.deliver(frame(3, { key: false, timestamp: 3_500 }));
    await flush();
    view.reply(view.subscribes[0]!, "binds");
    await flush();
    expect(view.drawn.map((picture) => picture.sequence)).toEqual([1]);
    expect(view.mediaAcks.map((ack) => ack.message)).toContainEqual(
      expect.objectContaining({ type: "screen.ack", sequence: 1, keyframe: true }),
    );
  });

  it("an unstamped ack goes nowhere: the channel delivers no live pictures to ack", async () => {
    const view = harness();
    view.client.retainStream("app");
    view.reply(view.subscribes[0]!, "binds");
    await flush();
    view.deliver(frame(1));
    await flush();
    const { generation: _, ...unstamped } = view.drawn[0]!;
    view.client.ack(unstamped);
    expect(view.mediaAcks).toEqual([]);
    expect(view.channelAcks).toEqual([]);
    // The media connection lost: still nothing goes on the channel.
    view.move(undefined);
    view.reply(view.subscribes[1]!, "channel");
    await flush();
    view.client.ack(unstamped);
    expect(view.channelAcks).toEqual([]);
  });

  it("a subscribe that times out stops holding pictures, and its late reply still settles delivery", async () => {
    const view = harness();
    view.client.retainStream("app");
    const [subscribe] = view.subscribes;
    view.timeOut();
    await flush();
    // No answer in time: nothing comes by the channel instead (X3).
    view.onChannel(frame(1));
    await flush();
    expect(view.drawn).toEqual([]);
    // The answer comes late: the daemon delivers by the media connection after all.
    view.reply(subscribe!, "binds");
    await flush();
    view.deliver(frame(2));
    await flush();
    expect(view.drawn.map((picture) => picture.sequence)).toEqual([2]);
    view.client.ack(view.drawn[0]!);
    expect(view.mediaAcks.map((ack) => ack.on)).toEqual(["mc_aaaaaaaaaa"]);
  });

  it("a subscribe that fails for another reason stops holding pictures and tries again later", async () => {
    const view = harness();
    view.client.retainStream("app");
    view.reply(view.subscribes[0]!, "fails");
    await flush();
    // Nothing was delivered before it, and the channel delivers nothing (X3).
    view.onChannel(frame(1));
    await flush();
    expect(view.drawn).toEqual([]);
    // A bounded backoff later, it subscribes again, naming the connection.
    expect(view.subscribes).toHaveLength(1);
    view.timeOut();
    await flush();
    expect(view.subscribes).toHaveLength(2);
    expect(view.subscribes[1]?.media).toEqual({ connection: "mc_aaaaaaaaaa" });
  });

  it("a released stream or a closed channel leaves no retry waiting on the clock", async () => {
    const view = harness();
    const release = view.client.retainStream("app");
    view.reply(view.subscribes[0]!, "fails");
    await flush();
    expect(view.pendingTimers()).toBe(1);
    release();
    expect(view.pendingTimers()).toBe(1); // the unsubscribe's own deadline
    view.timeOut();
    await flush();
    const again = harness();
    again.client.retainStream("app");
    again.reply(again.subscribes[0]!, "fails");
    await flush();
    again.client.disconnect();
    expect(again.pendingTimers()).toBe(0);
  });

  it("a fresh subscribe cancels the retry it supersedes on the clock", async () => {
    const view = harness();
    view.client.retainStream("app");
    view.reply(view.subscribes[0]!, "fails");
    await flush();
    expect(view.pendingTimers()).toBe(1);
    // The binding moves: the stream subscribes again at once, so the waiting retry goes.
    view.move("mc_bbbbbbbbbb");
    expect(view.subscribes).toHaveLength(2);
    expect(view.pendingTimers()).toBe(1); // the new subscribe's own deadline
    view.timeOut();
    await flush();
    expect(view.subscribes).toHaveLength(2);
  });
});

describe("a subscribe answered without delivery", () => {
  it("asks again on its own, still naming the connection, until ace-media serves it", async () => {
    const view = harness();
    view.client.retainStream("app");
    // ace-media couldn't serve the session: no `media` in the reply.
    view.reply(view.subscribes[0]!, "channel");
    await flush();
    expect(view.subscribes).toHaveLength(1);
    // Its retry comes round: it subscribes again, naming the same connection.
    view.timeOut();
    await flush();
    expect(view.subscribes).toHaveLength(2);
    expect(view.subscribes[1]?.media).toEqual({ connection: "mc_aaaaaaaaaa" });
    // Served this time: pictures come, and no retry is left waiting for it.
    view.reply(view.subscribes[1]!, "binds");
    await flush();
    view.deliver(frame(1));
    await flush();
    expect(view.drawn.map((picture) => picture.sequence)).toEqual([1]);
    view.timeOut();
    await flush();
    expect(view.subscribes).toHaveLength(2);
  });
});

describe("a bound view whose source isn't streaming", () => {
  it("says why until the first picture comes on it, whatever the daemon says in between", async () => {
    const view = harness();
    view.client.retainStream("app");
    view.reply(view.subscribes[0]!, "binds");
    await flush();
    expect(view.why()).toBeUndefined();
    // The daemon: the view is held, but nothing streams the session into ace-media.
    const starting = { code: "starting", reason: "Live video is starting. It shows in a moment." };
    view.server({ type: "screen.delivery", sessionId: "app", undelivered: starting });
    expect(view.why()).toBe(starting.reason);
    view.server({ type: "screen.delivery", sessionId: "app" });
    expect(view.why()).toBeUndefined();
    view.server({ type: "screen.delivery", sessionId: "app", undelivered: starting });
    // The first picture on the delivery clears it.
    view.deliver(frame(1));
    await flush();
    expect(view.drawn.map((picture) => picture.sequence)).toEqual([1]);
    expect(view.why()).toBeUndefined();
  });

  it("keeps the reason through a retry until the retry's delivery brings a picture", async () => {
    const view = harness();
    view.client.retainStream("app");
    // ace-media couldn't serve it: the reason stands.
    view.reply(view.subscribes[0]!, "channel");
    await flush();
    const why = view.why();
    expect(why).toBeDefined();
    // Its retry goes out and is answered: the old picture must not pass for a live one yet.
    view.timeOut();
    await flush();
    expect(view.why()).toEqual(why);
    view.reply(view.subscribes[1]!, "binds");
    await flush();
    expect(view.why()).toEqual(why);
    view.deliver(frame(1));
    await flush();
    expect(view.why()).toBeUndefined();
  });
});
