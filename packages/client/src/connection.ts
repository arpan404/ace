import { parseCredential } from "./credentials.ts";
import { retryDelay, disconnectDecision, networkDecision } from "./lifecycle.ts";
import { fitsUtf8 } from "./bounds.ts";
import { FragmentPolicy } from "./fragment-policy.ts";
import type { ClientMessage, ServerMessage as Message } from "@ace/protocol";
import type { WireCodec } from "./wire-codec.ts";
import {
  ClientError,
  type ClientOptions,
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
    a.lastReadyAt === b.lastReadyAt
  );
}

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
  #heartbeat: (() => void) | undefined;
  #healthy: (() => void) | undefined;
  #awaitingPong = false;
  #codec: WireCodec;
  #binary: ((bytes: Uint8Array) => void) | undefined;
  /** Frames waiting, in order, for the service schemas a frame among them needs. */
  #held: (string | Uint8Array)[] | undefined;
  #heldBytes = 0;
  #fragments: FragmentPolicy;
  #fragmentTimers = new Map<string, () => void>();
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
    this.#fragments = new FragmentPolicy(limits.fragmentBytes);
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
  info(): ConnectionInfo {
    return {
      state: this.state,
      attempt: this.#attempt,
      ...(this.#retry?.at !== undefined ? { nextRetryAt: this.#retry.at } : {}),
      ...(this.#since !== undefined ? { since: this.#since } : {}),
      ...(this.#lastReadyAt !== undefined ? { lastReadyAt: this.#lastReadyAt } : {}),
    };
  }

  #setState(state: ConnectionState): void {
    if (state !== this.state) this.#since = this.#options.now?.();
    this.state = state;
    this.#changed();
  }
  #cleanup(): void {
    this.#epoch++;
    this.#held = undefined;
    this.#heldBytes = 0;
    this.#fragments.clear();
    for (const cancel of this.#fragmentTimers.values()) cancel();
    this.#fragmentTimers.clear();
    this.#cancel?.();
    this.#cancel = undefined;
    this.#retry = undefined;
    this.#heartbeat?.();
    this.#heartbeat = undefined;
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
    this.error = error;
    this.#cleanup();
    this.#setState("fatal");
    this.#disconnected();
  }
  #lost(code: number): void {
    const decision = disconnectDecision(this.#active, this.#online, code);
    if (decision === "fatal") {
      this.fail(new ClientError(code === 4002 ? "protocol" : code === 1009 ? "limit" : "auth"));
      return;
    }
    this.error =
      code === 4013
        ? new ClientError("limit", "Device state subscriber capacity reached; retrying")
        : undefined;
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
    const wait = code === 4013 ? Math.max(5000, delay) : delay;
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
    this.#cancel = this.#options.scheduler.set(this.#limits.requestMs, () => this.#lost(1006));
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
              if (error instanceof ClientError && error.code === "offline") this.#lost(1006);
              else this.fail(new ClientError("auth"));
            });
        },
        close: (code) => {
          if (epoch === this.#epoch) this.#lost(code);
        },
        message: (text) => this.#receiveFrame(text, epoch),
        binary: (bytes) => this.#receiveFrame(bytes, epoch),
      });
    } catch {
      this.#lost(1006);
    }
  }
  #receiveFrame(frame: string | Uint8Array, epoch: number): void {
    if (epoch !== this.#epoch) return;
    if (frame instanceof Uint8Array && (frame.length <= 16 || frame.length > 65536 + 16)) {
      this.fail(new ClientError("protocol"));
      return;
    }
    if (this.#held) {
      this.#heldBytes += typeof frame === "string" ? frame.length * 2 : frame.byteLength;
      if (this.#heldBytes > this.#limits.frameBytes * 4) this.#lost(4009);
      else this.#held.push(frame);
      return;
    }
    if (typeof frame === "string") this.#receive(frame, epoch);
    else {
      try {
        if (this.state !== "ready" || !this.#binary) throw new ClientError("protocol");
        this.#binary(frame);
      } catch (error) {
        this.fail(error instanceof ClientError ? error : new ClientError("protocol"));
      }
    }
  }
  /** Hold `text` and every frame after it until the service schemas load, then go on in order. */
  #hold(text: string, epoch: number): void {
    const held: (string | Uint8Array)[] = [text];
    this.#held = held;
    this.#heldBytes = text.length * 2;
    this.#codec.load().then(
      () => {
        if (epoch !== this.#epoch || this.#held !== held) return;
        this.#held = undefined;
        for (const next of held) {
          if (epoch !== this.#epoch) return;
          this.#receiveFrame(next, epoch);
        }
      },
      () => {
        if (epoch === this.#epoch) this.fail(new ClientError("protocol"));
      },
    );
  }
  #receive(text: string, epoch: number): void {
    try {
      if (!fitsUtf8(text, this.#limits.frameBytes)) throw new ClientError("limit");
      const message = this.#codec.decode(JSON.parse(text));
      if (!message) {
        this.#hold(text, epoch);
        return;
      }
      if (message.type === "error" && message.code === "unauthorized") {
        this.fail(new ClientError("auth"));
        return;
      }
      if (
        message.type === "welcome" &&
        this.#options.expectedHostId !== undefined &&
        message.hostId !== this.#options.expectedHostId
      )
        throw new ClientError("auth", "Unexpected daemon identity");
      if (this.state !== "ready") {
        if (message.type !== "welcome") throw new ClientError("protocol");
        this.#cancel?.();
        this.#cancel = undefined;
        // Backoff starts over only once this connection has stayed up for a while.
        this.#healthy = this.#options.scheduler.set(this.#limits.healthyMs, () => {
          this.#attempt = 0;
          this.#healthy = undefined;
          this.#changed();
        });
        this.#awaitingPong = false;
        this.error = undefined;
        this.#since = this.#lastReadyAt = this.#options.now?.();
        this.state = "ready";
        this.#tick();
        this.#received(message);
        this.#changed();
        return;
      } else if (message.type === "welcome") throw new ClientError("protocol");
      if (message.type === "snapshot.part" || message.type === "entities.page.part") {
        this.#receiveFragment(message, epoch);
        return;
      }
      if (message.type === "pong") this.#awaitingPong = false;
      this.#received(message);
    } catch (error) {
      this.fail(error instanceof ClientError ? error : new ClientError("protocol"));
    }
  }
  #receiveFragment(
    message: Extract<Message, { type: "snapshot.part" | "entities.page.part" }>,
    epoch: number,
  ): void {
    const key =
      message.type === "snapshot.part"
        ? `snapshot:${message.subscriptionId}`
        : `page:${message.requestId}`;
    let data: string | undefined;
    try {
      data = this.#fragments.add(key, message.seq, message.index, message.data, message.done);
    } catch (error) {
      if (error instanceof ClientError && error.code === "limit") {
        this.#lost(4009);
        return;
      }
      throw error;
    }
    if (message.index === 0)
      this.#fragmentTimers.set(
        key,
        this.#options.scheduler.set(this.#limits.fragmentMs, () => {
          if (epoch === this.#epoch) this.#lost(4009);
        }),
      );
    if (data === undefined) return;
    this.#fragmentTimers.get(key)?.();
    this.#fragmentTimers.delete(key);
    const complete = this.#codec.decode(JSON.parse(data));
    if (message.type === "snapshot.part") {
      if (
        !complete ||
        complete.type !== "snapshot" ||
        complete.subscriptionId !== message.subscriptionId ||
        complete.seq !== message.seq
      )
        throw new ClientError("protocol");
    } else if (
      !complete ||
      complete.type !== "entities.page" ||
      complete.requestId !== message.requestId ||
      complete.page.threadId !== message.threadId ||
      complete.page.seq !== message.seq
    )
      throw new ClientError("protocol");
    this.#received(complete);
  }
  #tick(): void {
    if (this.state !== "ready") return;
    this.#heartbeat = this.#options.scheduler.set(this.#limits.heartbeatMs, () => {
      if (this.#awaitingPong) {
        this.#lost(1006);
        return;
      }
      this.#awaitingPong = true;
      this.send({ type: "ping" });
      if (this.state === "ready") this.#tick();
    });
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
      else this.#lost(1006);
      return false;
    }
  }
}
