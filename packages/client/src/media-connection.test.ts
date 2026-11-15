import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePicture, streamKinds, type StreamMessage } from "@ace/browser/stream";
import { MediaConnection, mediaHello, type MediaSocketEvents } from "./media-connection.ts";

const vector = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../native/media/vectors/media-link/${name}`, import.meta.url), {
      encoding: "utf8",
    }),
  );

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const ticket = base64url(new Uint8Array(32).map((_, index) => index + 1));
const granted = (connection: string, url: string | null = "ws://127.0.0.1:9/media") => ({
  type: "media.connect.result",
  requestId: "r1",
  result: { ok: true, connection, ticket, expiresAt: 30_000, ...(url ? { url } : {}) },
});

class Clock {
  now = 0;
  timers: { at: number; run: () => void }[] = [];
  schedule = (run: () => void, ms: number) => {
    const timer = { at: this.now + ms, run };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  };
  async advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.now = next.at;
      next.run();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

interface FakeSocket {
  url: string;
  events: MediaSocketEvents;
  sent: (string | Uint8Array)[];
  closed: number | undefined;
}

function harness(replies: unknown[]) {
  const clock = new Clock();
  const sockets: FakeSocket[] = [];
  let asked = 0;
  const media = new MediaConnection({
    connect: async () => {
      const reply = replies[Math.min(asked++, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return reply;
    },
    socket: (url, events) => {
      const socket: FakeSocket = { url, events, sent: [], closed: undefined };
      sockets.push(socket);
      return {
        send: (data) => void socket.sent.push(data),
        close: (code) => void (socket.closed = code ?? 1000),
      };
    },
    schedule: clock.schedule,
    now: () => clock.now,
  });
  const changes: (string | undefined)[] = [];
  media.watch(() => changes.push(media.binding()?.connection));
  const welcome = (socket: FakeSocket, connection: string) => {
    socket.events.open();
    socket.events.message(JSON.stringify({ type: "media.welcome", connection }));
  };
  return { media, clock, sockets, changes, welcome, asked: () => asked };
}

describe("media connection", () => {
  it("says hello with the shared vector's bytes", () => {
    const hello = vector("hello.json") as { ticketHex: string; hex: string };
    const bytes = Buffer.from(hello.ticketHex, "hex");
    expect(hex(mediaHello(base64url(bytes)))).toBe(hello.hex);
  });

  it("names the connection in subscribes once ace-media welcomes the ticket", async () => {
    const { media, sockets, changes, welcome } = harness([granted("mc_aaaaaaaaaa")]);
    media.start();
    const settled = media.settled();
    await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:9/media");
    expect(media.binding()).toBeUndefined();
    welcome(sockets[0]!, "mc_aaaaaaaaaa");
    await settled;
    expect(hex(sockets[0]!.sent[0] as Uint8Array)).toBe(hex(mediaHello(ticket)));
    expect(media.binding()).toEqual({ connection: "mc_aaaaaaaaaa" });
    expect(changes).toEqual(["mc_aaaaaaaaaa"]);
  });

  it("sends acks on the media connection only while it is open", async () => {
    const { media, sockets, welcome } = harness([granted("mc_aaaaaaaaaa")]);
    const ack = {
      type: "screen.ack",
      sessionId: "screen-1",
      streamId: "capture-1",
      sequence: 7,
    } as const;
    media.start();
    await flush();
    expect(media.ack(ack)).toBe(false);
    welcome(sockets[0]!, "mc_aaaaaaaaaa");
    expect(media.ack(ack)).toBe(true);
    expect(JSON.parse(sockets[0]!.sent[1] as string)).toEqual(ack);
  });

  it("hands pictures from the media connection to its listeners", async () => {
    const { media, sockets, welcome } = harness([granted("mc_aaaaaaaaaa")]);
    const received: StreamMessage[] = [];
    media.onStream((message) => received.push(message));
    media.start();
    await flush();
    welcome(sockets[0]!, "mc_aaaaaaaaaa");
    const pieces = encodePicture(
      streamKinds.screenFrame,
      1,
      "screen-1",
      {
        sequence: 3,
        timestamp: 10,
        width: 4,
        height: 2,
        scale: 1,
        rotation: 0,
        codec: "hvc1.1.6.L153.B0",
        key: true,
        streamId: "capture-1",
      },
      new Uint8Array([0, 0, 0, 1, 0x40]),
    );
    for (const piece of pieces) sockets[0]!.events.message(piece);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "screen.frame",
      sourceId: "screen-1",
      frame: { sequence: 3, codec: "hvc1.1.6.L153.B0", key: true },
    });
  });

  it("stays legacy when the daemon has no media connection to give", async () => {
    const unavailable = {
      type: "media.connect.result",
      requestId: "r1",
      result: { ok: false, code: "unavailable", message: "media.delivery is legacy" },
    };
    const { media, sockets, clock, asked } = harness([unavailable]);
    media.start();
    await media.settled();
    expect(media.state).toEqual({ state: "legacy", reason: "unavailable" });
    expect(media.binding()).toBeUndefined();
    expect(sockets).toHaveLength(0);
    // A setting may change: it asks again later.
    await clock.advance(30_000);
    expect(asked()).toBe(2);
  });

  it("treats a daemon that doesn't know media.connect as legacy", async () => {
    const { media, sockets } = harness([
      { type: "error", requestId: "r1", code: "unknown_type", message: "Unknown" },
    ]);
    media.start();
    await media.settled();
    expect(media.state).toEqual({ state: "legacy", reason: "unsupported" });
    expect(sockets).toHaveLength(0);
  });

  it("goes legacy when only the relay reaches the daemon", async () => {
    const { media, sockets } = harness([granted("mc_aaaaaaaaaa", null)]);
    media.start();
    await media.settled();
    expect(media.state).toEqual({ state: "legacy", reason: "relay" });
    expect(sockets).toHaveLength(0);
  });

  it("settles as legacy when the connection doesn't open in time", async () => {
    const { media, clock } = harness([granted("mc_aaaaaaaaaa")]);
    media.start();
    let settled = false;
    void media.settled().then(() => (settled = true));
    await clock.advance(1_999);
    expect(settled).toBe(false);
    await clock.advance(1);
    expect(settled).toBe(true);
    expect(media.binding()).toBeUndefined();
  });

  it("reconnects with a new ticket after ace-media goes away, and views resubscribe", async () => {
    const { media, sockets, clock, changes, welcome } = harness([
      granted("mc_aaaaaaaaaa"),
      granted("mc_bbbbbbbbbb"),
    ]);
    media.start();
    await flush();
    welcome(sockets[0]!, "mc_aaaaaaaaaa");
    sockets[0]!.events.close(1001);
    expect(media.binding()).toBeUndefined();
    await clock.advance(249);
    expect(sockets).toHaveLength(1);
    await clock.advance(1);
    expect(sockets).toHaveLength(2);
    welcome(sockets[1]!, "mc_bbbbbbbbbb");
    expect(media.binding()).toEqual({ connection: "mc_bbbbbbbbbb" });
    // Each change is one resubscribe: to the main socket while it was down, then to the new one.
    expect(changes).toEqual(["mc_aaaaaaaaaa", undefined, "mc_bbbbbbbbbb"]);
  });

  it("drops a welcome that names another connection", async () => {
    const { media, sockets, welcome } = harness([granted("mc_aaaaaaaaaa")]);
    media.start();
    await flush();
    welcome(sockets[0]!, "mc_zzzzzzzzzz");
    expect(media.binding()).toBeUndefined();
    expect(sockets[0]!.closed).toBe(4400);
  });

  it("drops a socket that opens but is never welcomed", async () => {
    const { media, sockets, clock } = harness([granted("mc_aaaaaaaaaa")]);
    media.start();
    await flush();
    sockets[0]!.events.open();
    await clock.advance(5_000);
    expect(sockets[0]!.closed).toBe(4400);
    await clock.advance(250);
    expect(sockets).toHaveLength(2);
  });

  it("ends with its main session and ignores the old socket after", async () => {
    const { media, sockets, welcome, changes } = harness([granted("mc_aaaaaaaaaa")]);
    media.start();
    await flush();
    welcome(sockets[0]!, "mc_aaaaaaaaaa");
    media.stop();
    expect(sockets[0]!.closed).toBe(1000);
    expect(media.state).toEqual({ state: "off" });
    sockets[0]!.events.message(JSON.stringify({ type: "media.welcome", connection: "mc_aaaaaaaaaa" }));
    expect(media.binding()).toBeUndefined();
    expect(changes).toEqual(["mc_aaaaaaaaaa", undefined]);
  });

  it("pings with the round trip it measured", async () => {
    const { media, sockets, clock, welcome } = harness([granted("mc_aaaaaaaaaa")]);
    media.start();
    await flush();
    welcome(sockets[0]!, "mc_aaaaaaaaaa");
    await clock.advance(5_000);
    expect(JSON.parse(sockets[0]!.sent.at(-1) as string)).toEqual({ type: "ping" });
    await clock.advance(420);
    sockets[0]!.events.message(JSON.stringify({ type: "pong" }));
    await clock.advance(4_580);
    expect(JSON.parse(sockets[0]!.sent.at(-1) as string)).toEqual({ type: "ping", rttMs: 420 });
  });
});
