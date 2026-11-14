import type { ByteSource, LaneSocket } from "./lanes.ts";
import type { MediaChild, MediaClock, MediaHost, MediaSupervisorOptions } from "./supervisor.ts";
import { legacyMediaSettings } from "./supervisor.ts";
import { decodeToMedia, encodeControl, type FromMedia, type ToMedia } from "./wire.ts";

/** A clock whose timers run only when the test advances it. */
export class ManualClock implements MediaClock {
  #now = 0;
  #timers: { at: number; seq: number; run: () => void }[] = [];
  #seq = 0;
  now(): number {
    return this.#now;
  }
  setTimeout(callback: () => void, ms: number): () => void {
    const timer = { at: this.#now + ms, seq: this.#seq++, run: callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((t) => t !== timer);
    };
  }
  /** Runs every timer due within `ms`, in order, letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      await settle();
      const next = this.#timers
        .filter((t) => t.at <= end)
        .toSorted((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((t) => t !== next);
      this.#now = next.at;
      next.run();
    }
    this.#now = end;
    await settle();
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

class Source implements ByteSource {
  #data: ((chunk: Uint8Array) => void)[] = [];
  #end: ((error?: Error) => void)[] = [];
  ended = false;
  onData(listener: (chunk: Uint8Array) => void): void {
    this.#data.push(listener);
  }
  onEnd(listener: (error?: Error) => void): void {
    this.#end.push(listener);
  }
  emit(chunk: Uint8Array): void {
    for (const listener of this.#data) listener(chunk);
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const listener of this.#end) listener();
  }
}

/** Collects written chunks into control frames, decoded on demand. */
class Sink {
  chunks: Uint8Array[] = [];
  /** While true, writes report backpressure and stay unflushed (a child that stops reading). */
  blocked = false;
  #drain: (() => void)[] = [];
  #pending: (() => void)[] = [];
  write(chunk: Uint8Array, done: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    if (this.blocked) this.#pending.push(() => done());
    else queueMicrotask(() => done());
    return !this.blocked;
  }
  onDrain(listener: () => void): void {
    this.#drain.push(listener);
  }
  unblock(): void {
    this.blocked = false;
    for (const done of this.#pending.splice(0)) done();
    for (const listener of this.#drain) listener();
  }
  bytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
  /** Every whole control frame written so far, decoded. */
  messages(lane: "normal" | "priority", skip = 0): { message: ToMedia; payload: Uint8Array }[] {
    const bytes = this.bytes().subarray(skip);
    const out: { message: ToMedia; payload: Uint8Array }[] = [];
    let offset = 0;
    while (offset + 4 <= bytes.length) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0);
      if (offset + 4 + length > bytes.length) break;
      out.push(decodeToMedia(bytes.slice(offset, offset + 4 + length), lane));
      offset += 4 + length;
    }
    return out;
  }
  types(lane: "normal" | "priority", skip = 0): string[] {
    return this.messages(lane, skip).map(({ message }) => message.type);
  }
}

export function frame(
  message: FromMedia,
  lane: "normal" | "priority",
  payload: Uint8Array = new Uint8Array(0),
) {
  const { header } = encodeControl(message, payload, lane);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

export class FakeSocket implements LaneSocket {
  readonly sink = new Sink();
  readonly source = new Source();
  destroyed = false;
  hello?: Uint8Array;
  private readonly media: FakeMedia;
  constructor(media: FakeMedia) {
    this.media = media;
  }
  write(chunk: Uint8Array, done: (error?: Error | null) => void): boolean {
    if (!this.hello) {
      this.hello = chunk.slice();
      queueMicrotask(() => done());
      this.media.onHello(this);
      return true;
    }
    return this.sink.write(chunk, done);
  }
  onDrain(listener: () => void): void {
    this.sink.onDrain(listener);
  }
  onData(listener: (chunk: Uint8Array) => void): void {
    this.source.onData(listener);
  }
  onEnd(listener: (error?: Error) => void): void {
    this.source.onEnd(listener);
  }
  destroy(): void {
    this.destroyed = true;
    this.source.end();
  }
  get lane(): "priority" | "egress" | undefined {
    return this.hello?.[4] === 1 ? "priority" : this.hello?.[4] === 2 ? "egress" : undefined;
  }
  /** Priority-lane messages the daemon wrote. */
  types(): string[] {
    return this.sink.types("priority");
  }
}

export type FakeBehaviour = {
  version: string;
  /** Answers `init` with `ready`. */
  ready: boolean;
  answerPings: boolean;
  answerRevocations: boolean;
  /** Refuses socket lanes whatever their secret. */
  refuseLanes: boolean;
  /** Exits as soon as it starts, with this code. */
  exitAtOnce?: number | undefined;
};

/** One fake ace-media process: checks the lane secret, answers pings and revocations. */
export class FakeMedia implements MediaChild {
  readonly pid: number;
  readonly stdin = new Sink();
  readonly stdout = new Source();
  readonly stderr = new Source();
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly sockets: FakeSocket[] = [];
  killed = false;
  gone = false;
  #exit!: (exit: { code: number | null; signal: string | null }) => void;
  #seen = 0;
  #secret?: Uint8Array;

  readonly behaviour: FakeBehaviour;

  constructor(pid: number, behaviour: FakeBehaviour) {
    this.pid = pid;
    this.behaviour = behaviour;
    this.exited = new Promise((resolve) => (this.#exit = resolve));
    const write = this.stdin.write.bind(this.stdin);
    this.stdin.write = (chunk, done) => {
      const open = write(chunk, done);
      this.#onStdin();
      return open;
    };
    if (behaviour.exitAtOnce !== undefined) {
      const code = behaviour.exitAtOnce;
      queueMicrotask(() => this.exit(code, null));
    }
  }

  kill(): void {
    this.killed = true;
    this.exit(null, "SIGKILL");
  }

  exit(code: number | null, signal: string | null): void {
    if (this.gone) return;
    this.gone = true;
    for (const socket of this.sockets) socket.source.end();
    this.#exit({ code, signal });
  }

  send(message: FromMedia, payload: Uint8Array = new Uint8Array(0)): void {
    this.stdout.emit(frame(message, "normal", payload));
  }

  /** The lane socket for `lane`, once connected. */
  lane(lane: "priority" | "egress"): FakeSocket {
    const socket = this.sockets.find((s) => s.lane === lane);
    if (!socket) throw new Error(`no ${lane} lane`);
    return socket;
  }

  get initSecret(): Uint8Array | undefined {
    return this.#secret;
  }

  onHello(socket: FakeSocket): void {
    const hello = socket.hello;
    const secret = this.#secret;
    const ok =
      !this.behaviour.refuseLanes &&
      hello !== undefined &&
      secret !== undefined &&
      hello.length === 37 &&
      new DataView(hello.buffer).getUint32(0) === 0x4143454c &&
      hello.subarray(5).every((byte, i) => byte === secret[i]);
    queueMicrotask(() => (ok ? socket.source.emit(Uint8Array.of(1)) : socket.source.end()));
  }

  #onStdin(): void {
    if (this.stdin.blocked) return;
    const messages = this.stdin.messages("normal");
    for (const { message, payload } of messages.slice(this.#seen)) this.#handle(message, payload);
    this.#seen = messages.length;
  }

  #handle(message: ToMedia, payload: Uint8Array): void {
    if (message.type === "init") {
      this.#secret = payload.slice();
      if (!this.behaviour.ready) return;
      queueMicrotask(() =>
        this.send({
          type: "ready",
          protocol: 1,
          version: this.behaviour.version,
          pid: this.pid,
          capabilities: {
            encoders: [{ codec: "h264", hardware: true, backend: "fake" }],
            decoders: [],
            stills: true,
          },
          ingest: { socket: "/fake/ingest", websocketPort: 4100 },
          control: { socket: "/fake/control" },
          listen: { loopbackPort: 4101 },
        }),
      );
    }
    if (message.type === "ping" && this.behaviour.answerPings)
      this.send({
        type: "pong",
        id: message.id,
        stats: {
          sources: 0,
          viewers: 0,
          connections: 0,
          cpuMs: 1,
          rssBytes: 1,
          bytesOut: 0,
          priorityLagMs: 0,
        },
      });
  }

  /** Answers every revocation on the priority lane written so far. */
  answerRevocations(): void {
    const lane = this.lane("priority");
    for (const { message } of lane.sink.messages("priority"))
      if (message.type === "revoke")
        lane.source.emit(frame({ type: "revoked", id: message.id }, "priority"));
      else if (message.type === "connection.close" || message.type === "relay.close")
        lane.source.emit(frame({ type: "closed", id: message.id }, "priority"));
  }
}

export class FakeHost implements MediaHost {
  readonly children: FakeMedia[] = [];
  behaviour: FakeBehaviour = {
    version: "1.2.3",
    ready: true,
    answerPings: true,
    answerRevocations: true,
    refuseLanes: false,
  };
  spawn(): MediaChild {
    const child = new FakeMedia(1000 + this.children.length, { ...this.behaviour });
    this.children.push(child);
    return child;
  }
  async connect(): Promise<LaneSocket> {
    const child = this.children.at(-1);
    if (!child) throw new Error("no child");
    const socket = new FakeSocket(child);
    child.sockets.push(socket);
    const write = socket.sink.write.bind(socket.sink);
    socket.sink.write = (chunk, done) => {
      const open = write(chunk, done);
      if (child.behaviour.answerRevocations && socket.lane === "priority")
        queueMicrotask(() => {
          if (!child.killed) child.answerRevocations();
        });
      return open;
    };
    return socket;
  }
  get last(): FakeMedia {
    const child = this.children.at(-1);
    if (!child) throw new Error("no child");
    return child;
  }
}

export function harness(overrides: Partial<MediaSupervisorOptions> = {}) {
  const host = new FakeHost();
  const clock = new ManualClock();
  const events = {
    exits: [] as Parameters<NonNullable<MediaSupervisorOptions["onExit"]>>[0][],
    messages: [] as FromMedia[],
    egress: [] as Uint8Array[],
    replays: 0,
  };
  const options: MediaSupervisorOptions = {
    version: "1.2.3",
    binary: "/opt/ace/media/ace-media",
    runtimeDir: "/run/ace",
    dataDir: "/data/ace",
    settings: () => ({ ...legacyMediaSettings, delivery: "auto" }),
    host,
    clock,
    random: () => 0.5,
    randomBytes: (length) => Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff),
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    replay: () => void events.replays++,
    onMessage: (message) => void events.messages.push(message),
    onEgress: (bytes) => void events.egress.push(bytes),
    onExit: (exit) => void events.exits.push(exit),
    log: () => {},
    ...overrides,
  };
  return { host, clock, events, options };
}
