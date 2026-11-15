import { describe, expect, it } from "vitest";
import { ScreenState, ServerMessage, type MediaStreamClientMessage } from "@ace/protocol";
import { encodePicture, streamKinds, type StreamMessage } from "@ace/browser/stream";
import { ScreenStreamClient, type MediaRoute, type SourcePicture } from "./screen-stream.ts";

const state = ScreenState.parse({
  sessionId: "app",
  lifecycle: "live",
  controller: "none",
  indicator: false,
  target: { kind: "app", bundleId: "com.apple.calculator" },
  permissions: { screenRecording: true, accessibility: true },
});

const picture = (sequence: number, codec = "hvc1.1.6.L153.B0") =>
  encodePicture(
    streamKinds.screenFrame,
    sequence,
    "app",
    {
      sequence,
      timestamp: sequence,
      width: 4,
      height: 2,
      scale: 1,
      rotation: 0,
      codec,
      key: true,
      streamId: "capture-1",
    },
    Uint8Array.of(0, 0, 0, 1, 0x40),
  );

function fakeRoute(initial: string | undefined) {
  let connection = initial;
  const watchers = new Set<() => void>();
  const streams = new Set<(message: StreamMessage) => void>();
  const acks: MediaStreamClientMessage[] = [];
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
      acks.push(message);
      return true;
    },
  };
  return {
    route,
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

/** How the daemon answers a subscribe naming a connection: binds it, serves it here, or refuses. */
type Daemon = "binds" | "serves here" | "refuses" | "answers later";

function harness(daemon: Daemon = "binds") {
  const sent: unknown[] = [];
  let events: Parameters<Parameters<ScreenStreamClient["connect"]>[0]["open"]>[0] | undefined;
  let ids = 0;
  const client = new ScreenStreamClient({ id: () => `r${++ids}`, schedule: () => () => {} });
  client.connect({
    open: (handlers) => void (events = handlers),
    send: (message) => {
      sent.push(message);
      if (message.type !== "screen.request" || message.operation.op !== "subscribe") return;
      if (daemon === "answers later") return;
      const { requestId, operation } = message;
      const named = operation.media;
      queueMicrotask(() =>
        server(
          ServerMessage.parse(
            named && daemon === "refuses"
              ? {
                  type: "screen.result",
                  requestId,
                  ok: false,
                  error: "media-connection: that media connection isn't this session's",
                }
              : {
                  type: "screen.result",
                  requestId,
                  ok: true,
                  ...(named && daemon === "binds"
                    ? { media: { connection: named.connection } }
                    : {}),
                },
          ),
        ),
      );
    },
    close: () => {},
  });
  events!.ready();
  const server = (message: ServerMessage | Uint8Array) => events!.message(message);
  server(ServerMessage.parse({ type: "screen.state", state }));
  const drawn: SourcePicture[] = [];
  client.watchPictures("app", (shown) => void drawn.push(shown));
  return { client, sent, server, drawn };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const subscribes = (sent: unknown[]) =>
  sent.flatMap((message) =>
    typeof message === "object" &&
    message !== null &&
    "operation" in message &&
    typeof message.operation === "object" &&
    message.operation !== null &&
    "op" in message.operation &&
    message.operation.op === "subscribe"
      ? [message.operation]
      : [],
  );

describe("screen pictures by the media connection", () => {
  it("subscribes on the media connection with the viewer's codecs, and acks there", async () => {
    const { client, sent, drawn } = harness();
    const media = fakeRoute("mc_aaaaaaaaaa");
    client.useMedia(media.route);
    client.retainStream("app");
    expect(subscribes(sent)).toEqual([
      {
        op: "subscribe",
        sessionId: "app",
        media: { connection: "mc_aaaaaaaaaa" },
        codecs: ["hvc1.1.6.L153.B0", "avc1.42E033"],
      },
    ]);
    media.deliver({
      kind: "screen.frame",
      sourceId: "app",
      frame: {
        sequence: 1,
        timestamp: 1,
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
    await flush();
    expect(drawn.map((p) => p.sequence)).toEqual([1]);
    client.ack(drawn[0]!);
    expect(media.acks).toEqual([
      { type: "screen.ack", sessionId: "app", streamId: "capture-1", sequence: 1 },
    ]);
    expect(
      sent.some(
        (m) => typeof m === "object" && m !== null && "type" in m && m.type === "screen.ack",
      ),
    ).toBe(false);
  });

  it("subscribes again with the new connection after the media connection reconnects", () => {
    const { client, sent } = harness();
    const media = fakeRoute("mc_aaaaaaaaaa");
    client.useMedia(media.route);
    client.retainStream("app");
    media.move(undefined);
    media.move("mc_bbbbbbbbbb");
    expect(
      subscribes(sent).map((operation) => ("media" in operation ? operation.media : undefined)),
    ).toEqual([{ connection: "mc_aaaaaaaaaa" }, undefined, { connection: "mc_bbbbbbbbbb" }]);
  });

  it("keeps legacy delivery on the channel while the media connection has no binding", async () => {
    const { client, sent, server, drawn } = harness();
    const media = fakeRoute(undefined);
    client.useMedia(media.route);
    client.retainStream("app");
    expect(subscribes(sent)).toEqual([{ op: "subscribe", sessionId: "app" }]);
    for (const piece of picture(4, "avc1.42E033")) server(piece);
    await flush();
    client.ack(drawn[0]!);
    expect(media.acks).toEqual([]);
    expect(sent.at(-1)).toEqual({
      type: "screen.ack",
      sessionId: "app",
      streamId: "capture-1",
      sequence: 4,
    });
  });

  it("keeps acks on the channel when the daemon serves the stream there itself", async () => {
    const { client, sent, server, drawn } = harness("serves here");
    const media = fakeRoute("mc_aaaaaaaaaa");
    client.useMedia(media.route);
    client.retainStream("app");
    await flush();
    for (const piece of picture(5, "avc1.42E033")) server(piece);
    await flush();
    client.ack(drawn[0]!);
    expect(media.acks).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ type: "screen.ack", sequence: 5 });
  });

  it("subscribes on the channel when the daemon refuses the connection", async () => {
    const { client, sent } = harness("refuses");
    client.useMedia(fakeRoute("mc_aaaaaaaaaa").route);
    client.retainStream("app");
    await flush();
    expect(
      subscribes(sent).map((operation) => ("media" in operation ? operation.media : undefined)),
    ).toEqual([{ connection: "mc_aaaaaaaaaa" }, undefined]);
  });

  it("keeps the poster a media subscribe brings back", async () => {
    const { client, sent, server } = harness("answers later");
    client.useMedia(fakeRoute("mc_aaaaaaaaaa").route);
    client.retainStream("app");
    await flush();
    const request = sent.find(
      (m): m is { requestId: string } =>
        typeof m === "object" && m !== null && "requestId" in m && typeof m.requestId === "string",
    );
    const poster = { width: 4, height: 2, jpeg: "/9j/AA==" };
    server(
      ServerMessage.parse({
        type: "screen.result",
        requestId: request!.requestId,
        ok: true,
        media: { connection: "mc_aaaaaaaaaa", poster },
      }),
    );
    expect(client.poster("app")).toEqual(poster);
  });
});
