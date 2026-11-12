import { parseCredential, type Credential } from "./credentials.ts";
import { handshakePath, type PathRoute, type WelcomedPath } from "./path-handshake.ts";
import { pathTiming } from "./path-plan.ts";
import { retryDelay, disconnectDecision, networkDecision } from "./lifecycle.ts";
import { fitsUtf8 } from "./bounds.ts";
import { FragmentAssembly, matchesFragments, type FragmentPart } from "./fragment-assembly.ts";
import { Heartbeat } from "./heartbeat.ts";
import { HeldFrames, type Frame } from "./held-frames.ts";
import {
  ACCESS_CHANGED_CLOSE,
  keepGrant,
  type GrantKeeper,
  type GrantRefreshResult,
} from "./grant-keeper.ts";
import type { PathStandby } from "./multipath.ts";
import { supportedWireTrims, WireRestorer } from "@ace/projection/wire-trim";
import {
  CredentialReplacedClose,
  DeviceRevokedClose,
  MachineCodeRefusal,
  type ClientMessage,
  type ServerMessage as Message,
} from "@ace/protocol";
import type { WireCodec } from "./wire-codec.ts";
import {
  ClientError,
  type ClientOptions,
  type ConnectionClose,
  type ConnectionInfo,
  type ConnectionState,
  type Limits,
  type PathRefusal,
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

/**
 * What the client does when the connection moves to another path (ADR 0114): catch every view
 * up on the new path from its last applied seq, and return what to do once the old path is
 * gone (fail its unanswered requests, ask its unanswered commands again by id).
 */
export type PathSwitched = (mode: "switch" | "failover") => () => void;
/** The old path after a swap, still delivering replies it owed until it drains. */
interface Draining {
  epoch: number;
  transport: Transport | undefined;
  restorer: WireRestorer;
  fragments: FragmentAssembly;
  finished: () => void;
  cancel: () => void;
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
  #deliver: (message: Message) => void;
  /** Puts back what the daemon left out of this socket's messages; a socket starts it anew. */
  #restorer = new WireRestorer();
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
  /** The daemon the last welcome named: every other path must reach this one. */
  #hostId: string | undefined;
  #draining: Draining | undefined;
  #switched: PathSwitched | undefined;
  /** Drops the path whose welcome named another daemon (`Multipath`). */
  #refusedPath: (() => void) | undefined;
  /** A warm path to fail over to when the active one drops (`standby`). */
  #standby: PathStandby | undefined;
  #pongs: (() => void)[] = [];
  /** Each open socket's grant refresh, for an account device (ADR 0114): stopped when it ends. */
  #keepers = new Map<Transport, GrantKeeper>();
  /** Frames heard on the active path, so a late pong behind a busy stream isn't a miss. */
  #heard = 0;
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
    this.#deliver = received;
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
  #received(message: Message): void {
    const whole = this.#restorer.restore(message);
    if (whole) this.#deliver(whole);
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
   * The person typed the machine code the daemon asked for: open again now, from a fresh
   * backoff, so the next hello carries it. A connection stopped for any other reason stays
   * stopped (a refused or revoked credential can't be fixed by trying again); one still
   * retrying skips its wait, as `reconnectNow`.
   */
  codeEntered(): void {
    if (!this.#active) return;
    if (this.state !== "fatal") {
      this.reconnectNow();
      return;
    }
    if (this.error?.code !== "machine_code") return;
    this.error = undefined;
    this.#attempt = 0;
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
    this.#pongs = [];
    // The connection is gone: the client's disconnect handles what the old path owed.
    this.#closeDraining();
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
    this.#unkeep(transport);
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
    const decision = disconnectDecision(this.#active, this.#online, code, reason);
    const closed = {
      code,
      // Close reasons are short protocol phrases; bounded so a log line stays one line.
      reason: reason.slice(0, 120),
      heartbeatMissed: reason === heartbeatMissed,
      wasReady: this.state === "ready",
      attempt: this.#attempt,
    };
    if (decision === "reconnecting" && this.#failover(code, reason)) return;
    if (decision !== "reconnecting")
      this.#report("connection.closed", { ...closed, next: decision });
    if (decision === "fatal") {
      this.fail(
        code === 4011
          ? new ClientError("machine_code", reason)
          : code === 4403
            ? new ClientError("auth", "This machine isn't on your ace account.")
            : DeviceRevokedClose.safeParse({ code, reason }).success
              ? ClientError.revoked(reason)
              : new ClientError(code === 4002 ? "protocol" : "auth"),
      );
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
    this.#restorer = new WireRestorer();
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
            .then(() => transport.credential?.() ?? this.#options.credential())
            .then((credential) => {
              if (epoch === this.#epoch) this.send(this.#hello(transport, credential));
            })
            .catch((error: unknown) => {
              if (epoch !== this.#epoch) return;
              if (error instanceof ClientError && error.code === "offline")
                this.#lost(1006, "Credential unavailable offline");
              else this.fail(new ClientError("auth"));
            });
        },
        close: (code, reason, refused) => this.#closed(epoch, code, reason ?? "", refused),
        message: (text) => this.#receiveFrame(text, epoch),
        binary: (bytes) => this.#receiveFrame(bytes, epoch),
      });
    } catch {
      this.#lost(1006, "Transport failed to open");
    }
  }
  #hello(transport: Transport, credential: Credential): ClientMessage {
    return {
      type: "hello",
      protocolVersion: 1,
      deviceId: this.#options.deviceId,
      ...(this.#options.installId ? { installId: this.#options.installId } : {}),
      trims: [...supportedWireTrims],
      // A frame may hold several messages, one per line; #receiveFrame reads each in turn.
      framing: ["lines"],
      ...(transport.compression?.length ? { compression: [...transport.compression] } : {}),
      ...(transport.flowControl?.length ? { flowControl: [...transport.flowControl] } : {}),
      ...parseCredential(credential),
    };
  }
  /** A server frame that breaks the protocol: drop this socket and reconnect with backoff. */
  #broken(reason: string, error = new ClientError("protocol", reason)): void {
    this.#lost(1002, reason, error);
  }
  #receiveFrame(frame: Frame, epoch: number): void {
    // A packed frame (hello `framing: lines`) is its messages in order, as if each came alone.
    // JSON text never holds a raw newline, so a single message never splits.
    if (typeof frame === "string" && frame.includes("\n")) {
      for (const line of frame.split("\n")) this.#receiveFrame(line, epoch);
      return;
    }
    if (epoch !== this.#epoch) {
      if (epoch === this.#draining?.epoch) this.#drainFrame(frame, this.#draining);
      return;
    }
    this.#heard++;
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
    let value: unknown;
    try {
      value = JSON.parse(text);
      return this.#codec.decode(value);
    } catch (error) {
      // The frame's type and the first issue say which message didn't read, for the log.
      const type =
        typeof value === "object" && value !== null && "type" in value ? String(value.type) : "";
      const issue = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 160) : "";
      this.#broken(`Undecodable server message ${type} ${issue}`.trim(), versionMismatch());
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
      if (this.state !== "ready") {
        if (message.type === "error") {
          // A direct path refuses an account device's hello by asking for the machine code,
          // then closes: the person must enter it, so the connection stops (ADR 0111).
          const refusal = MachineCodeRefusal.safeParse(message.code);
          if (refusal.success) {
            this.fail(new ClientError("machine_code", refusal.data, message.lockedUntil));
            return;
          }
        }
        if (message.type === "starting") {
          this.#setState("starting");
          return;
        }
        if (message.type !== "welcome") {
          this.#broken(`Unexpected ${message.type} before welcome`);
          return;
        }
        // Every path must reach the daemon this connection was pinned to or first welcomed by.
        const expected = this.#hostId ?? this.#options.expectedHostId;
        if (expected !== undefined && message.hostId !== expected) {
          this.#wrongHost(epoch);
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
        this.#startHeartbeat();
        this.#keepGrant(this.#transport, message);
        this.#hostId = message.hostId;
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
      if (message.type === "account.grant.refresh.result") {
        this.#grantAnswered(this.#transport, message);
        return;
      }
      if (message.type === "pong") this.#pongs.shift()?.();
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
  /**
   * A path reached another daemon than the one this connection speaks to. With several paths,
   * that path is dropped and the others race again; with one, nothing else can help.
   */
  #wrongHost(epoch: number): void {
    if (!this.#refusedPath) {
      this.fail(new ClientError("identity", "Unexpected daemon identity"));
      return;
    }
    const error = new ClientError("identity", "Path reached another machine");
    this.#refusedPath();
    if (epoch === this.#epoch) this.#lost(1006, error.message, error);
  }
  #startHeartbeat(): void {
    this.#heartbeat.start({
      ping: () => this.#ping(() => {}) && this.state === "ready",
      missed: () => this.#lost(1006, heartbeatMissed),
    });
  }
  #closed(epoch: number, code: number, reason: string, refused?: PathRefusal): void {
    // A drop whose paths were partly refused retries, and says why while it does.
    if (epoch === this.#epoch)
      this.#lost(
        code,
        reason,
        refused && new ClientError("offline", refused.reason || `Path refused (${refused.code})`),
      );
    else if (epoch === this.#draining?.epoch) this.#finishDrain();
  }

  /** What the client does when the connection moves to another path. */
  onPathSwitch(switched: PathSwitched): void {
    this.#switched = switched;
  }
  /** The path the current attempt won reached another daemon: never use it again. */
  onWrongHost(refused: (() => void) | undefined): void {
    this.#refusedPath = refused;
  }
  /** Where a dropped active path fails over to at once, before any reconnect backoff. */
  setStandby(standby: PathStandby | undefined): void {
    this.#standby = standby;
  }
  /** Frames heard on the active path so far: a ping that hears anything was not missed. */
  get heard(): number {
    return this.#heard;
  }
  /** Ping the active path; resolves with its pong. Never rejects: callers set a deadline. */
  ping(): Promise<void> {
    return new Promise((resolve) => {
      if (this.state === "ready") this.#ping(resolve);
    });
  }
  /**
   * Every ping on the active path, the heartbeat's too, waits in one queue: the daemon answers
   * a socket's pings in order, so each pong settles the oldest ping, never a newer one.
   */
  #ping(answered: () => void): boolean {
    if (!this.send({ type: "ping" })) return false;
    // A socket that stops answering is dropped by the heartbeat long before this fills.
    if (this.#pongs.push(answered) > 64) this.#pongs.shift();
    return true;
  }
  /**
   * Open `route` beside the active path with this device's credential, and wait for the same
   * daemon to welcome it (ADR 0114). The active path carries on untouched; a failure here
   * changes nothing.
   */
  openBeside(route: PathRoute): Promise<WelcomedPath> {
    const hostId = this.#hostId;
    if (this.state !== "ready" || hostId === undefined)
      return Promise.reject(new ClientError("offline", "No active path"));
    return handshakePath({
      route,
      hostId,
      scheduler: this.#options.scheduler,
      timeoutMs: this.#limits.handshakeMs,
      hello: (transport, credential) =>
        JSON.stringify(this.#codec.encode(this.#hello(transport, credential))),
      decode: (text) => this.#codec.decode(JSON.parse(text)),
      // A standby hears nothing else it needs before it is taken, but its grant's answers.
      untaken: (transport, frame) => {
        if (typeof frame !== "string" || !frame.includes('"account.grant.refresh.result"')) return;
        for (const line of frame.split("\n"))
          try {
            const message = this.#codec.decode(JSON.parse(line));
            if (message?.type === "account.grant.refresh.result")
              this.#grantAnswered(transport, message);
          } catch {
            /* Not an answer this keeper can use; the standby's own checks handle a bad path. */
          }
      },
    }).then((path) => this.#kept(path));
  }
  /**
   * An account socket's grant runs out unless it is refreshed on that socket (ADR 0114): keep
   * it fresh for as long as the socket is open, whether it is active, a standby or draining.
   */
  #keepGrant(transport: Transport | undefined, welcome: Extract<Message, { type: "welcome" }>) {
    const grant = this.#options.grant;
    if (!transport || welcome.grantTtlMs === undefined || !grant) return;
    this.#unkeep(transport);
    this.#keepers.set(
      transport,
      keepGrant({
        ttlMs: welcome.grantTtlMs,
        grant: () => grant(),
        scheduler: this.#options.scheduler,
        id: () => this.#options.id(),
        send: (message) => transport.send(JSON.stringify(this.#codec.encode(message))),
        refused: () => this.#grantRefused(transport),
      }),
    );
  }
  #unkeep(transport: Transport | undefined): void {
    if (!transport) return;
    this.#keepers.get(transport)?.stop();
    this.#keepers.delete(transport);
  }
  #grantAnswered(transport: Transport | undefined, message: GrantRefreshResult): void {
    if (transport) this.#keepers.get(transport)?.answered(message);
  }
  /**
   * The daemon refused a socket's refresh for good (the machine code, or this account's
   * grants): end that socket now. The active one reconnects, and its next hello gets the
   * refusal the person can act on; another path only closes.
   */
  #grantRefused(transport: Transport): void {
    this.#unkeep(transport);
    if (transport === this.#transport) {
      this.#lost(ACCESS_CHANGED_CLOSE, "Account access changed");
      return;
    }
    try {
      transport.close();
    } catch {
      /* Already gone. */
    }
  }
  /** A path opened beside the active one, whose grant is kept fresh until it closes. */
  #kept(path: WelcomedPath): WelcomedPath {
    this.#keepGrant(path.transport, path.welcome);
    const stop = () => this.#unkeep(path.transport);
    path.onClosed(stop);
    return {
      transport: path.transport,
      welcome: path.welcome,
      get heard() {
        return path.heard;
      },
      take: (events) => path.take(events),
      send: (text) => path.send(text),
      close: () => {
        stop();
        path.close();
      },
      onClosed: (listener) =>
        path.onClosed((code, reason) => {
          stop();
          listener(code, reason);
        }),
    };
  }
  /**
   * Make `path` the active path: one pointer swap, after which every send goes there. The old
   * path keeps delivering the replies it owed for `drainMs`, then closes; a failover's old path
   * is already gone. False (nothing changed) unless the connection is ready on one path.
   */
  swap(path: WelcomedPath, mode: "switch" | "failover"): boolean {
    if (this.state !== "ready" || this.#draining || this.#held.holding) return false;
    const old = {
      epoch: this.#epoch,
      transport: this.#transport,
      restorer: this.#restorer,
      fragments: this.#fragments,
    };
    const epoch = ++this.#epoch;
    this.#transport = path.transport;
    this.#restorer = new WireRestorer();
    this.#fragments = new FragmentAssembly(
      this.#limits.fragmentBytes,
      this.#options.scheduler,
      this.#limits.fragmentMs,
    );
    this.#pongs = [];
    path.take({
      frame: (frame) => this.#receiveFrame(frame, epoch),
      close: (code, reason) => this.#closed(epoch, code, reason),
    });
    this.#startHeartbeat();
    const finished = this.#switched?.(mode) ?? (() => {});
    this.#draining = {
      ...old,
      finished,
      cancel:
        mode === "failover"
          ? () => {}
          : this.#options.scheduler.set(pathTiming.drainMs, () => this.#finishDrain()),
    };
    if (mode === "failover") this.#finishDrain();
    this.#report("connection.path_switched", { mode });
    return true;
  }
  /** A missed pong on the active path: fail over now, or reconnect as after any drop. */
  failover(reason: string): void {
    if (this.state === "ready") this.#lost(1006, reason);
  }
  #failover(code: number, reason: string): boolean {
    // Access changed on every path at once: the standby can't carry on either.
    // A replaced credential: the standby said hello with it too, and closes with it.
    if (
      this.state !== "ready" ||
      this.#draining ||
      code === ACCESS_CHANGED_CLOSE ||
      CredentialReplacedClose.safeParse({ code, reason }).success
    )
      return false;
    const standby = this.#standby?.path();
    if (!standby || !this.swap(standby, "failover")) return false;
    this.#standby?.used(code);
    this.#report("connection.failover", { code, reason: reason.slice(0, 120) });
    return true;
  }
  #drainFrame(frame: Frame, draining: Draining): void {
    if (typeof frame !== "string") {
      try {
        this.#binary?.(frame);
      } catch {
        this.#finishDrain();
      }
      return;
    }
    try {
      const message = this.#codec.decode(JSON.parse(frame));
      if (!message || message.type === "pong") return;
      if (message.type === "account.grant.refresh.result") {
        this.#grantAnswered(draining.transport, message);
        return;
      }
      if (message.type === "snapshot.part" || message.type === "entities.page.part") {
        const data = draining.fragments.add(message, () => {});
        const complete = data === undefined ? undefined : this.#codec.decode(JSON.parse(data));
        if (complete && matchesFragments(message, complete)) {
          const whole = draining.restorer.restore(complete);
          if (whole) this.#deliver(whole);
        }
        return;
      }
      const whole = draining.restorer.restore(message);
      if (whole) this.#deliver(whole);
    } catch {
      // The old path broke while draining: what it owed is asked again on the new one.
      this.#finishDrain();
    }
  }
  /** The old path is done: close it, then settle what it never answered. */
  #finishDrain(): void {
    const draining = this.#draining;
    if (!draining) return;
    this.#closeDraining();
    draining.finished();
  }
  #closeDraining(): void {
    const draining = this.#draining;
    if (!draining) return;
    this.#draining = undefined;
    draining.cancel();
    draining.fragments.clear();
    this.#unkeep(draining.transport);
    try {
      draining.transport?.close();
    } catch {
      /* Already gone. */
    }
  }
}
