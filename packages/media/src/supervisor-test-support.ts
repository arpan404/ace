import { createHmac, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { deriveLaneKeys, LaneRecords, laneTranscript } from "./lane-records.ts";
import { laneAccepted, type ByteSource, type LaneSocket } from "./lanes.ts";
import type { MediaChild, MediaClock, MediaHost, MediaSupervisorOptions } from "./supervisor.ts";
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
    if (this.ended) listener();
    else this.#end.push(listener);
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

/** ace-media's lane proofs: HMAC-SHA256 keyed by the lane secret (`media_wire::lane`). */
function laneProof(secret: Uint8Array, side: "server" | "client", ...parts: Uint8Array[]) {
  const hmac = createHmac("sha256", secret).update(`ace-media lane v1 ${side}`);
  for (const part of parts) hmac.update(part);
  return new Uint8Array(hmac.digest());
}

type LaneChallenge = {
  secret: Uint8Array;
  nonce: Uint8Array;
  serverNonce: Uint8Array;
  serverProof: Uint8Array;
};

/**
 * One lane connection as ace-media serves it. The daemon's side is the wire: the hello, the
 * proofs and then sealed records. The test's side is plaintext: `sink` holds the frames the
 * daemon wrote, and `source.emit` sends frames to the daemon, sealed once the lane is open.
 */
export class FakeSocket implements LaneSocket {
  readonly sink = new Sink();
  readonly #wire = new Source();
  readonly source = {
    emit: (plain: Uint8Array) => this.#wire.emit(this.#records?.seal(plain) ?? plain),
    end: () => this.#wire.end(),
  };
  destroyed = false;
  hello?: Uint8Array;
  #challenge: LaneChallenge | undefined;
  #records?: LaneRecords;
  private readonly media: FakeMedia;
  constructor(media: FakeMedia) {
    this.media = media;
  }
  write(chunk: Uint8Array, done: (error?: Error | null) => void): boolean {
    if (this.#records) return this.#writeSealed(chunk, done);
    queueMicrotask(() => done());
    if (!this.hello) {
      this.hello = chunk.slice();
      this.media.onHello(this);
    } else if (this.#challenge) this.media.onProof(this, chunk.slice());
    return true;
  }
  /** Sends ace-media's proof and nonce for the daemon's hello. */
  challenge(challenge: LaneChallenge): void {
    this.#challenge = challenge;
    const reply = Uint8Array.from([...challenge.serverProof, ...challenge.serverNonce]);
    queueMicrotask(() => this.#wire.emit(reply));
  }
  /** Checks the daemon's proof; once it holds, every byte either way is a record. */
  open(proof: Uint8Array): boolean {
    const challenge = this.#challenge;
    const tag = this.hello?.[4] ?? 0;
    if (!challenge || proof.length !== 32) return false;
    const { secret, nonce, serverNonce, serverProof } = challenge;
    const expected = laneProof(secret, "client", Uint8Array.of(tag), nonce, serverNonce);
    if (!timingSafeEqual(proof, expected)) return false;
    const keys = deriveLaneKeys(
      secret,
      laneTranscript(tag, nonce, serverNonce, serverProof, proof),
    );
    this.#records = new LaneRecords(keys.toDaemon, keys.toMedia);
    this.#challenge = undefined;
    return true;
  }
  #writeSealed(chunk: Uint8Array, done: (error?: Error | null) => void): boolean {
    let plains: Uint8Array[];
    try {
      plains = this.#records?.open(chunk) ?? [];
    } catch (error) {
      this.destroy();
      queueMicrotask(() => done(error instanceof Error ? error : new Error(String(error))));
      return false;
    }
    let open = true;
    plains.forEach((plain, i) => {
      open = this.sink.write(plain, i === plains.length - 1 ? done : () => {});
    });
    if (plains.length === 0) queueMicrotask(() => done());
    return open;
  }
  onDrain(listener: () => void): void {
    this.sink.onDrain(listener);
  }
  onData(listener: (chunk: Uint8Array) => void): void {
    this.#wire.onData(listener);
  }
  onEnd(listener: (error?: Error) => void): void {
    this.#wire.onEnd(listener);
  }
  destroy(): void {
    this.destroyed = true;
    this.#wire.end();
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
  /** Holds this lane's accept until `releaseHeld()`. */
  hold?: "priority" | "egress" | undefined;
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

/** One fake ace-media process: checks the lane proofs, answers pings and revocations. */
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
  readonly #accepted = new Set<number>();
  #held?: () => void;

  readonly behaviour: FakeBehaviour;

  constructor(pid: number, behaviour: FakeBehaviour) {
    this.pid = pid;
    this.behaviour = behaviour;
    this.exited = new Promise((resolve) => (this.#exit = resolve));
    const unblock = this.stdin.unblock.bind(this.stdin);
    this.stdin.unblock = () => {
      unblock();
      this.#onStdin();
    };
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

  /**
   * ace-media's lane rules: a well-formed hello for a known tag not used before, answered with
   * this side's proof over the daemon's nonce and a nonce of its own; then the daemon's proof
   * over both, made with init's secret; and no lane once both are up. A refused lane is closed
   * without an answer.
   */
  onHello(socket: FakeSocket): void {
    const hello = socket.hello;
    const secret = this.#secret;
    const tag = hello?.[4] ?? 0;
    const ok =
      !this.behaviour.refuseLanes &&
      hello !== undefined &&
      secret !== undefined &&
      hello.length === 37 &&
      new DataView(hello.buffer).getUint32(0) === 0x4143454c &&
      (tag === 1 || tag === 2) &&
      !this.#accepted.has(tag) &&
      this.#accepted.size < 2;
    if (!ok || !secret) return void queueMicrotask(() => socket.source.end());
    const nonce = hello.slice(5);
    // ace-media's nonce is random; a fixed one per connection keeps the fake deterministic.
    const serverNonce = new Uint8Array(32).fill(this.sockets.indexOf(socket) + 1);
    const serverProof = laneProof(secret, "server", Uint8Array.of(tag), nonce);
    socket.challenge({ secret, nonce, serverNonce, serverProof });
  }

  /** The daemon's proof: a wrong one, or a tag taken meanwhile, closes the lane unanswered. */
  onProof(socket: FakeSocket, proof: Uint8Array): void {
    const tag = socket.hello?.[4] ?? 0;
    if (this.#accepted.has(tag) || !socket.open(proof))
      return void queueMicrotask(() => socket.source.end());
    this.#accepted.add(tag);
    const accept = () => socket.source.emit(Uint8Array.of(laneAccepted));
    if (this.behaviour.hold === socket.lane) this.#held = accept;
    else queueMicrotask(accept);
  }

  releaseHeld(): void {
    this.#held?.();
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
          capabilities: [
            {
              step: "encode",
              codec: "avc1.640028",
              backend: "vt",
              hardware: true,
              zeroCopy: true,
              state: "ok",
              maxWidth: 4096,
              maxHeight: 2304,
            },
          ],
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

/**
 * Removes a stopped process's runtime directory. On Windows its files stay held for a moment
 * after the kill (the process, or the browser its probe started), so a busy directory is retried.
 */
export async function removeWhenFree(dir: string, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (performance.now() > end || (code !== "EBUSY" && code !== "EPERM")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
