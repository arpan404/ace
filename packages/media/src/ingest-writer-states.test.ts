/*
 * The ingest writer's states (open → finishing → ended | cut) against a scripted socket: the
 * test decides when each write completes, whether it fails, when the socket closes and when the
 * drain limit runs out, then checks what reached the socket and what was reported.
 */
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { decodeMediaFrame, type MediaFrame } from "./frame.ts";
import { IngestWriter, type IngestSocket } from "./ingest-writer.ts";

/** A socket whose writes complete only when the test says, in order. */
class ScriptedSocket extends EventEmitter implements IngestSocket {
  readonly queue: { bytes: Uint8Array; done: (error?: Error | null) => void }[] = [];
  /** Every frame written, as `kind:mark` (the payload's first byte), in order. */
  readonly seen: string[] = [];
  ended = false;
  destroyed = false;

  get writableLength(): number {
    return this.queue.reduce((total, write) => total + write.bytes.length, 0);
  }

  write(bytes: Uint8Array, done: (error?: Error | null) => void): boolean {
    const frame = decodeMediaFrame(bytes);
    this.seen.push(`${frame.kind}:${frame.payload[0] ?? "-"}`);
    this.queue.push({ bytes, done });
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  /** The oldest write reaches the kernel, or fails. */
  complete(error?: Error): void {
    this.queue.shift()?.done(error ?? null);
  }

  completeAll(): void {
    while (this.queue.length > 0) this.complete();
  }

  /** The peer went away. */
  close(): void {
    this.emit("close");
  }
}

function unit(mark: number, keyframe: boolean, bytes = 16): MediaFrame {
  return {
    kind: 1,
    flags: keyframe ? 1 : 0,
    ageUs: 0,
    width: 2,
    height: 2,
    displayWidth: 2,
    displayHeight: 2,
    scale: 1000,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 0,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array(bytes).fill(mark),
  };
}

function setup() {
  const socket = new ScriptedSocket();
  const cuts: string[] = [];
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
  const writer = new IngestWriter({
    socket: "unused",
    token: new Uint8Array(32),
    onClosed: (reason) => void cuts.push(reason ?? "?"),
    onKeyframe: () => {},
    limit: 1_000,
    connect: () => socket,
    after: (ms, run) => {
      const timer = { ms, run, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  });
  socket.complete(); // the hello
  /** The drain limit runs out, for every deadline still armed. */
  const expire = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
  };
  /** A big keyframe still in the socket, and a keyframe waiting behind it. */
  const backlogged = () => {
    writer.write(unit(1, true, 2_000));
    writer.write(unit(2, true));
  };
  return { socket, writer, cuts, expire, backlogged };
}

type Case = {
  name: string;
  run: (world: ReturnType<typeof setup>) => void;
  cuts: string[];
  /** What reached the socket after the hello. */
  seen: string[];
  ended: boolean;
  destroyed: boolean;
};

const cases: Case[] = [
  {
    name: "a write that fails while open is a cut, and nothing more is written",
    run: ({ socket, writer }) => {
      writer.write(unit(1, true));
      socket.complete(new Error("EPIPE"));
      expect(writer.write(unit(2, false))).toBe(false);
    },
    cuts: ["write-failed"],
    seen: ["1:1"],
    ended: false,
    destroyed: true,
  },
  {
    name: "a finish ends cleanly only once the end frame's write succeeds",
    run: ({ socket, writer }) => {
      writer.write(unit(1, true));
      writer.finish();
      socket.completeAll();
      socket.close();
    },
    cuts: [],
    seen: ["1:1", "4:-"],
    ended: true,
    destroyed: false,
  },
  {
    name: "a close before the end frame's write completes is a cut",
    run: ({ socket, writer }) => {
      writer.finish();
      socket.close();
    },
    cuts: ["closed"],
    seen: ["4:-"],
    ended: false,
    destroyed: true,
  },
  {
    name: "an end frame that stalls past the drain limit is a cut",
    run: ({ writer, expire }) => {
      writer.finish();
      expire();
    },
    cuts: ["drain-limit"],
    seen: ["4:-"],
    ended: false,
    destroyed: true,
  },
  {
    name: "a close while a finish holds its keyframe is a cut",
    run: ({ socket, writer, backlogged }) => {
      backlogged();
      writer.finish();
      socket.close();
    },
    cuts: ["closed"],
    seen: ["1:1"],
    ended: false,
    destroyed: true,
  },
  {
    name: "a finish whose keyframe can't go within the drain limit is a cut, with no end frame",
    run: ({ writer, expire, backlogged }) => {
      backlogged();
      writer.finish();
      expire();
    },
    cuts: ["drain-limit"],
    seen: ["1:1"],
    ended: false,
    destroyed: true,
  },
  {
    name: "a finish writes its keyframe once the backlog is written, then the end frame",
    run: ({ socket, writer, backlogged }) => {
      backlogged();
      writer.finish();
      socket.completeAll();
      socket.completeAll();
    },
    cuts: [],
    seen: ["1:1", "1:2", "4:-"],
    ended: true,
    destroyed: false,
  },
  {
    name: "a backlog write that fails during a finish is a cut: no keyframe, no end frame",
    run: ({ socket, writer, backlogged }) => {
      backlogged();
      writer.finish();
      socket.complete(new Error("EPIPE"));
    },
    cuts: ["write-failed"],
    seen: ["1:1"],
    ended: false,
    destroyed: true,
  },
  {
    name: "a finish's keyframe that goes but stalls past the drain limit is a cut",
    run: ({ socket, writer, expire, backlogged }) => {
      backlogged();
      writer.finish();
      socket.complete();
      expire();
    },
    cuts: ["drain-limit"],
    seen: ["1:1", "1:2", "4:-"],
    ended: false,
    destroyed: true,
  },
  {
    name: "a waiting keyframe goes when the backlog is written, with no drain event",
    run: ({ socket, backlogged }) => {
      backlogged();
      socket.complete();
    },
    cuts: [],
    seen: ["1:1", "1:2"],
    ended: false,
    destroyed: false,
  },
  {
    name: "the drain limit on an open path looks at the real backlog: one written is not cut",
    run: ({ socket, writer, expire }) => {
      writer.write(unit(1, true, 2_000));
      writer.write(unit(2, false));
      socket.complete();
      expire();
      writer.write(unit(3, true));
    },
    cuts: [],
    seen: ["1:1", "1:3"],
    ended: false,
    destroyed: false,
  },
  {
    name: "an open path whose backlog stays past the drain limit is cut",
    run: ({ backlogged, expire }) => {
      backlogged();
      expire();
    },
    cuts: ["drain-limit"],
    seen: ["1:1"],
    ended: false,
    destroyed: true,
  },
  {
    name: "a cut is reported once, however many ways it happens",
    run: ({ socket, writer, expire, backlogged }) => {
      backlogged();
      writer.finish();
      socket.complete(new Error("EPIPE"));
      socket.close();
      expire();
    },
    cuts: ["write-failed"],
    seen: ["1:1"],
    ended: false,
    destroyed: true,
  },
];

for (const test of cases)
  it(test.name, () => {
    const world = setup();
    test.run(world);
    expect(world.cuts).toEqual(test.cuts);
    expect(world.socket.seen.slice(1)).toEqual(test.seen);
    expect({ ended: world.socket.ended, destroyed: world.socket.destroyed }).toEqual({
      ended: test.ended,
      destroyed: test.destroyed,
    });
  });
