import { parseCredential } from "./credentials.ts";
import { retryDelay, disconnectDecision, networkDecision } from "./lifecycle.ts";
import { fitsUtf8 } from "./bounds.ts";
import { FragmentAssembly, matchesFragments, type FragmentPart } from "./fragment-assembly.ts";
import { Heartbeat } from "./heartbeat.ts";
import { HeldFrames, type Frame } from "./held-frames.ts";
import type { ClientMessage, ServerMessage as Message } from "@ace/protocol";
import type { WireCodec } from "./wire-codec.ts";
import {
  ClientError,
  type ClientOptions,
  type ConnectionClose,
  type ConnectionInfo,
  type ConnectionState,
  type Limits,
  type Transport,
} from "./types.ts";

/** Field by field, so a selection over `info()` notifies only when something changed. */
export function sameConnectionInfo(a: ConnectionInfo, b: ConnectionInfo): boolean {
  return (
    a.state === b.state &&
    a.attempt === b.attempt &&
    a.nextRetryAt === b.nextRetryAt &&
    a.since === b.since &&
    a.lastReadyAt === b.lastReadyAt &&
    a.lastClose === b.lastClose
  );
}

/** A server frame this build's schemas reject: the daemon is another version. */
const heartbeatMissed = "Heartbeat missed";
/** How long a woken app waits for the daemon to answer before it treats the socket as dead. */
const wakeProbeMs = 5000;

const versionMismatch = () =>
  new ClientError("version_mismatch", "The daemon sent a message this app can't read");

export class Connection {
  state: ConnectionState = "offline";
  error: ClientError | undefined;
  #options: ClientOptions;
  #limits: Limits;
  #received: (message: Message) => void;
  #changed: () => void;
  #disconnected: () => void;
  #transport: Transport | undefined;
  #epoch = 0;
  #attempt = 0;
  #online = true;
  #active = false;
  #cancel: (() => void) | undefined;
  /** A reconnect waiting on its backoff timer (`cancel`), and when it runs if there's a clock. */
  #retry: { at: number | undefined } | undefined;
  #since: number | undefined;
  #lastReadyAt: number | undefined;
  #lastClose: ConnectionClose | undefined;
  #heartbeat: Heartbeat;
  #healthy: (() => void) | undefined;
  #codec: WireCodec;
  #binary: ((bytes: Uint8Array) => void) | undefined;
  #held: HeldFrames;
  #fragments: FragmentAssembly;
  constructor(
    options: ClientOptions,
    codec: WireCodec,
    limits: Limits,
    received: (message: Message) => void,
    changed: () => void,
    disconnected: () => void,
    binary?: (bytes: Uint8Array) => void,
  ) {
    this.#options = options;
    this.#binary = binary;
    this.#codec = codec;
    this.#limits = limits;
    this.#received = received;
    this.#changed = changed;
    this.#disconnected = disconnected;
    this.#heartbeat = new Heartbeat(options.scheduler, limits.heartbeatMs);
    this.#held = new HeldFrames(limits.frameBytes * 4);
    this.#fragments = new FragmentAssembly(
      limits.fragmentBytes,
      options.scheduler,
      limits.fragmentMs,
    );
  }
  get supportsBinary(): boolean {
    return this.#transport?.supportsBinary === true;
  }
  start(): void {
    if (this.#active || this.state === "fatal") return;
    this.#active = true;
    this.#connect();
  }
  stop(): void {
    this.#active = false;
    this.#cleanup();
    this.#setState("offline");
    this.#disconnected();
  }
  networkOnline(online: boolean): void {
    const decision = networkDecision(this.state, this.#active, this.#online, online);
    this.#online = online;
    if (decision === "offline") {
      this.#cleanup();
      this.#setState("offline");
      this.#disconnected();
    } else if (decision === "connect") this.#connect();
  }

  /**
   * Skip the backoff: run the scheduled reconnect now, keeping the attempt count (a failure
   * still backs off further). Nothing happens unless a reconnect is waiting on its timer.
   */
  reconnectNow(): void {
    if (!this.#active || !this.#retry) return;
    this.#connect();
  }
  /**
   * The app came back to the foreground. A socket that sat suspended may be dead without having
   * closed, and a reconnect may be waiting out a long backoff: a ready socket must answer a ping
   * within a few seconds or is replaced, and a waiting reconnect runs now.
   */
  wake(): void {
    if (!this.#active) return;
    if (this.state === "ready") this.#heartbeat.probe(wakeProbeMs);
    else this.reconnectNow();
  }
  info(): ConnectionInfo {
    return {
      state: this.state,
      attempt: this.#attempt,
      ...(this.#retry?.at !== undefined ? { nextRetryAt: this.#retry.at } : {}),
      ...(this.#since !== undefined ? { since: this.#since } : {}),
      ...(this.#lastReadyAt !== undefined ? { lastReadyAt: this.#lastReadyAt } : {}),
      ...(this.#lastClose ? { lastClose: this.#lastClose } : {}),
    };
  }

  #report(event: string, data: Record<string, string | number | boolean | null>): void {
    try {
      this.#options.report?.({ event, data });
    } catch {
      /* A broken log never breaks the connection. */
    }
  }
  #setState(state: ConnectionState): void {
    if (state !== this.state) this.#since = this.#options.now?.();
    this.state = state;
    this.#changed();
  }
  #cleanup(): void {
    this.#epoch++;
    this.#held.clear();
    this.#fragments.clear();
    this.#cancel?.();
    this.#cancel = undefined;
    this.#retry = undefined;
    this.#heartbeat.stop();
    this.#healthy?.();
    this.#healthy = undefined;
    const transport = this.#transport;
    this.#transport = undefined;
    try {
      transport?.close();
    } catch {
      /* The epoch already excludes late callbacks. */
    }
  }
  fail(error: ClientError): void {
    this.#report("connection.failed", { code: error.code });
    this.error = error;
    this.#cleanup();
    this.#setState("fatal");
    this.#disconnected();
  }
  /**
   * The connection ended: keep why, then reconnect with backoff unless another attempt can't
   * help. `error` is what the person should know while it retries (a version mismatch).
   */
  #lost(code: number, reason: string, error?: ClientError): void {
    const at = this.#options.now?.();
    this.#lastClose = { code, reason, ...(at === undefined ? {} : { at }) };
    const decision = disconnectDecision(this.#active, this.#online, code);
    const closed = {
      code,
      // Close reasons are short protocol phrases; bounded so a log line stays one line.
      reason: reason.slice(0, 120),
      heartbeatMissed: reason === heartbeatMissed,
      wasReady: this.state === "ready",
      attempt: this.#attempt,
    };
    if (decision !== "reconnecting")
      this.#report("connection.closed", { ...closed, next: decision });
    if (decision === "fatal") {
      this.fail(new ClientError(code === 4002 ? "protocol" : "auth"));
      return;
    }
    this.error =
      error ??
      (code === 4013
        ? new ClientError("limit", "Device state subscriber capacity reached; retrying")
        : undefined);
    this.#cleanup();
    this.#disconnected();
    if (decision === "offline") {
      this.#setState("offline");
      return;
    }
    let delay: number;
    try {
      delay = retryDelay(
        this.#attempt++,
        this.#limits.retryBaseMs,
        this.#limits.retryCapMs,
        this.#options.random(),
      );
    } catch {
      this.fail(new ClientError("protocol"));
      return;
    }
    // A frame the client couldn't read (a server frame of another version) and 1009 come back
    // the same way on the next socket; backoff grows with every such failure until a
    // connection stays healthy, so they can't turn into a retry storm.
    const wait = code === 4013 ? Math.max(5000, delay) : delay;
    this.#report("connection.closed", {
      ...closed,
      next: decision,
      retryInMs: Math.round(wait),
    });
    this.#cancel = this.#options.scheduler.set(wait, () => this.#connect());
    const now = this.#options.now?.();
    this.#retry = { at: now === undefined ? undefined : now + wait };
    this.#setState("reconnecting");
  }
  #connect(): void {
    this.#cleanup();
    if (!this.#online) {
      this.#setState("offline");
      return;
    }
    this.#setState(this.#attempt ? "reconnecting" : "connecting");
    const epoch = this.#epoch;
    this.#cancel = this.#options.scheduler.set(this.#limits.handshakeMs, () =>
      this.#lost(1006, "Handshake timed out"),
    );
    try {
      const transport = this.#options.transport();
      this.#transport = transport;
      transport.open({
        open: () => {
          if (epoch !== this.#epoch) return;
          void Promise.resolve()
            .then(() => this.#options.credential())
            .then((credential) => {
              if (epoch === this.#epoch)
                this.send({
                  type: "hello",
                  protocolVersion: 1,
                  deviceId: this.#options.deviceId,
                  ...parseCredential(credential),
                });
            })
            .catch((error: unknown) => {
              if (epoch !== this.#epoch) return;
              if (error instanceof ClientError && error.code === "offline")
                this.#lost(1006, "Credential unavailable offline");
              else this.fail(new ClientError("auth"));
            });
        },
        close: (code, reason) => {
          if (epoch === this.#epoch) this.#lost(code, reason ?? "");
        },
        message: (text) => this.#receiveFrame(text, epoch),
        binary: (bytes) => this.#receiveFrame(bytes, epoch),
      });
    } catch {
      this.#lost(1006, "Transport failed to open");
    }
  }
  /** A server frame that breaks the protocol: drop this socket and reconnect with backoff. */
  #broken(reason: string, error = new ClientError("protocol", reason)): void {
    this.#lost(1002, reason, error);
  }
  #receiveFrame(frame: Frame, epoch: number): void {
    if (epoch !== this.#epoch) return;
    // Every frame proves the socket alive, so a pong queued behind a busy stream never drops it.
    this.#heartbeat.heard();
    if (frame instanceof Uint8Array && (frame.length <= 16 || frame.length > 65536 + 16)) {
      this.#broken("Binary frame out of bounds");
      return;
    }
    if (this.#held.holding) {
      if (!this.#held.push(frame)) this.#lost(4009, "Held frames over budget");
      return;
    }
    if (typeof frame === "string") this.#receive(frame, epoch);
    else if (this.state !== "ready" || !this.#binary) this.#broken("Unexpected binary frame");
    else {
      try {
        this.#binary(frame);
      } catch (error) {
        if (error instanceof ClientError && error.code !== "protocol") this.fail(error);
        else this.#broken("Unreadable binary frame");
      }
    }
  }
  /** A server frame's JSON, decoded; `null` once an unreadable one has dropped the socket. */
  #decode(text: string): Message | undefined | null {
    try {
      return this.#codec.decode(JSON.parse(text));
    } catch {
      this.#broken("Undecodable server message", versionMismatch());
      return null;
    }
  }
  /** Hold `text` and every frame after it until the service schemas load, then go on in order. */
  #hold(text: string, epoch: number): void {
    this.#held.hold(
      text,
      this.#codec.load(),
      (next) => this.#receiveFrame(next, epoch),
      () => {
        if (epoch === this.#epoch) this.fail(new ClientError("protocol"));
      },
    );
  }
  #receive(text: string, epoch: number): void {
    if (!fitsUtf8(text, this.#limits.frameBytes)) {
      this.fail(new ClientError("limit"));
      return;
    }
    const message = this.#decode(text);
    if (message === null) return;
    if (!message) {
      this.#hold(text, epoch);
      return;
    }
    try {
      if (message.type === "error" && message.code === "unauthorized") {
        this.fail(new ClientError("auth"));
        return;
      }
      if (
        message.type === "welcome" &&
        this.#options.expectedHostId !== undefined &&
        message.hostId !== this.#options.expectedHostId
      )
        throw new ClientError("identity", "Unexpected daemon identity");
      if (this.state !== "ready") {
        if (message.type === "starting") {
          this.#setState("starting");
          return;
        }
        if (message.type !== "welcome") {
          this.#broken(`Unexpected ${message.type} before welcome`);
          return;
        }
        this.#cancel?.();
        this.#cancel = undefined;
        // Backoff starts over only once this connection has stayed up for a while.
        this.#healthy = this.#options.scheduler.set(this.#limits.healthyMs, () => {
          this.#attempt = 0;
          this.#healthy = undefined;
          this.#changed();
        });
        this.error = undefined;
        this.#since = this.#lastReadyAt = this.#options.now?.();
        this.state = "ready";
        if (this.#lastClose) {
          const down =
            this.#since !== undefined && this.#lastClose.at !== undefined
              ? this.#since - this.#lastClose.at
              : undefined;
          this.#report("connection.recovered", {
            attempts: this.#attempt,
            ...(down === undefined ? {} : { downMs: down }),
          });
        }
        this.#heartbeat.start({
          ping: () => this.send({ type: "ping" }) && this.state === "ready",
          missed: () => this.#lost(1006, heartbeatMissed),
        });
        this.#received(message);
        this.#changed();
        return;
      } else if (message.type === "welcome") {
        this.#broken("Second welcome");
        return;
      }
      if (message.type === "snapshot.part" || message.type === "entities.page.part") {
        this.#receiveFragment(message, epoch);
        return;
      }
      this.#received(message);
    } catch (error) {
      this.fail(error instanceof ClientError ? error : new ClientError("protocol"));
    }
  }
  #receiveFragment(part: FragmentPart, epoch: number): void {
    let data: string | undefined;
    try {
      data = this.#fragments.add(part, () => {
        if (epoch === this.#epoch) this.#lost(4009, "Fragments timed out");
      });
    } catch (error) {
      if (error instanceof ClientError && error.code === "limit")
        this.#lost(4009, "Fragments over budget");
      else this.#broken("Fragment out of sequence");
      return;
    }
    if (data === undefined) return;
    const complete = this.#decode(data);
    if (complete === null) return;
    if (complete && matchesFragments(part, complete)) this.#received(complete);
    else this.#broken("Fragments don't match their message");
  }
  send(message: ClientMessage): boolean {
    if (!this.#transport) return false;
    try {
      const encoded = this.#codec.encode(message);
      // A service message before its schemas loaded is not sent, as when offline.
      if (!encoded) return false;
      const text = JSON.stringify(encoded);
      if (!fitsUtf8(text, this.#limits.sendBytes)) throw new ClientError("limit");
      this.#transport.send(text);
      return true;
    } catch (error) {
      if (error instanceof ClientError) this.fail(error);
      else this.#lost(1006, "Send failed");
      return false;
    }
  }
}
