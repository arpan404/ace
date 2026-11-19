import {
  DeviceId,
  MachineRefusal,
  type ClientMessage,
  type MachineCallRequest,
  type MachineRelayAnswer,
  type TransferRelayRequest,
} from "@ace/protocol";
import type { ClientChannel } from "@ace/relay";
import { MachineFailure, MachineNotSent, MachineTimeout, MachineUnpaired } from "./transport.ts";

/**
 * The machine's welcome on this relay didn't offer transfers (an older ace): nothing was sent,
 * and another route may still take them (ADR 0192).
 */
export class TransfersNotOffered extends MachineNotSent {}

/** What a person reads when no route but an older machine's relay was left. */
export const transfersNotOffered =
  "That machine's ace can't take projects and threads through a relay yet. Update ace there, or link it again where its address answers (LAN or Tailscale).";

/** What opening a relay stream to a machine needs; `connect` is `connectClientViaRelay`. */
export interface RelayLinkDeps {
  connect(options: {
    relayUrl: string;
    hostId: string;
    pinnedFingerprint: string;
    grant?: string;
    signal?: AbortSignal;
    aceClient?: string;
  }): Promise<ClientChannel>;
  /** This daemon's `ace-client` name (ADR 0189), given to ace's own relay only. */
  aceClient?: string | undefined;
  /**
   * An account device grant for ace's hosted relay at `url`, or undefined when this machine
   * can't get one or `url` isn't ace's relay as this machine knows it.
   */
  deviceGrant(deviceId: string, url: string, signal: AbortSignal): Promise<string | undefined>;
  /** Time for idle closes. */
  schedule(ms: number, run: () => void): () => void;
  /**
   * Whether the pairing this stream speaks for is still saved, asked right before each call:
   * an unlinked or re-paired machine gets nothing more through the relay, as on its address.
   */
  current(target: RelayTarget): boolean;
}

/** One relay stream to one machine, as this machine's paired device there. */
export interface RelayTarget {
  url: string;
  relayHostId: string;
  hosted: boolean;
  deviceId: string;
  token: string;
}

interface Pending {
  resolve(value: MachineRelayAnswer): void;
  reject(error: Error): void;
}

interface Stream {
  channel: ClientChannel;
  pending: Map<number, Pending>;
  next: number;
  /** The stream ended; a call that finds it opens a new one. */
  dead: boolean;
  /** The machine said in its welcome that it takes `machine.transfer` frames (ADR 0192). */
  transfers: boolean;
  stopIdle?: (() => void) | undefined;
}

/** A stream unused for this long closes; the next call opens a new one. */
const IDLE_MS = 60_000;
const CONNECT_MS = 15_000;

/**
 * Machine calls over a relay (ADR 0182). The stream is end to end encrypted and pinned to the
 * machine's relay host key (Noise, ADR 0070); inside it this machine says hello with its paired
 * device token, as it does on the machine's TLS listener, so the machine applies the same
 * pairing, grants and revocation. One stream per machine is kept while calls use it.
 */
export class RelayLink {
  private deps: RelayLinkDeps;
  private streams = new Map<string, Promise<Stream>>();
  /** The callers waiting on each stream still opening, by stream key. */
  private waiting = new Map<string, Set<{ signal?: AbortSignal | undefined }>>();
  constructor(deps: RelayLinkDeps) {
    this.deps = deps;
  }
  private key(target: RelayTarget) {
    // ace's hosted relay and the person's own get their own streams, so a route classified one
    // way never reuses a stream opened the other way (with or without an account grant).
    return `${target.hosted ? "hosted" : "own"}\n${target.url}\n${target.relayHostId}\n${target.deviceId}`;
  }
  private async open(target: RelayTarget): Promise<Stream> {
    // The deadline covers connecting and the hello only: an open stream outlives it.
    const opening = new AbortController();
    const stopDeadline = this.deps.schedule(CONNECT_MS, () => opening.abort());
    let channel: ClientChannel;
    try {
      const grant = target.hosted
        ? await this.deps.deviceGrant(target.deviceId, target.url, opening.signal)
        : undefined;
      if (target.hosted && !grant)
        throw new MachineFailure("offline", undefined, "Not signed in to ace for its relay");
      channel = await this.deps.connect({
        relayUrl: target.url,
        hostId: target.relayHostId,
        pinnedFingerprint: target.relayHostId,
        ...(grant ? { grant } : {}),
        ...(target.hosted && this.deps.aceClient ? { aceClient: this.deps.aceClient } : {}),
        signal: opening.signal,
      });
    } catch (error) {
      stopDeadline();
      throw error;
    }
    const late = () => channel.close();
    opening.signal.addEventListener("abort", late, { once: true });
    let welcome: Extract<Awaited<ReturnType<ClientChannel["receive"]>>, { type: "welcome" }>;
    try {
      // Both ends hold to a window the other has consumed (ADR 0110), so a slow reader here
      // holds back the machine instead of filling the relay.
      channel.flowControl?.();
      // The hello carries the pairing's token: sent only for a pairing still saved, and only
      // while some caller still waits for this stream (several may share one opening).
      if (!this.deps.current(target))
        throw new MachineUnpaired("offline", undefined, "Machine call never sent: unpaired");
      if (!this.wanted(this.key(target)))
        throw new MachineNotSent("offline", undefined, "No call waits for this stream any more");
      await channel.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse(target.deviceId),
        token: target.token,
        channel: "machine",
        flowControl: ["credit"],
      });
      const answer = await channel.receive();
      if (answer.type !== "welcome")
        throw new MachineFailure("refused", "unauthorized", "The machine refused this link");
      welcome = answer;
    } catch (error) {
      channel.close();
      throw error instanceof MachineFailure ? error : new MachineFailure("offline");
    } finally {
      stopDeadline();
      opening.signal.removeEventListener("abort", late);
    }
    const stream: Stream = {
      channel,
      pending: new Map(),
      next: 1,
      dead: false,
      transfers: welcome.machineTransfers === true,
    };
    void (async () => {
      try {
        for await (const frame of channel.frames()) {
          if (frame instanceof Uint8Array || frame.type !== "machine.answer") continue;
          const waiting = stream.pending.get(frame.id);
          stream.pending.delete(frame.id);
          waiting?.resolve(frame);
        }
      } catch {
        // The stream broke; every call on it is lost below.
      } finally {
        stream.dead = true;
        stream.stopIdle?.();
        for (const waiting of stream.pending.values())
          waiting.reject(new MachineFailure("disconnected"));
        stream.pending.clear();
        channel.close();
      }
    })();
    return stream;
  }
  private async stream(target: RelayTarget): Promise<Stream> {
    const key = this.key(target);
    const known = this.streams.get(key);
    if (known) {
      const stream = await known.catch(() => undefined);
      if (stream && !stream.dead) return stream;
      if (this.streams.get(key) === known) this.streams.delete(key);
      const again = this.streams.get(key);
      if (again) return again;
    }
    const opening = this.open(target);
    this.streams.set(key, opening);
    opening.catch(() => {
      if (this.streams.get(key) === opening) this.streams.delete(key);
    });
    return opening;
  }
  /** One machine call on the stream; failures read as the direct transport's do. */
  call(
    target: RelayTarget,
    body: MachineCallRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    return this.exchange(
      target,
      (id, timeoutMs) => ({
        type: "machine.call",
        id,
        request: body,
        timeoutMs,
      }),
      options,
    );
  }
  /**
   * One transfer call on the stream (ADR 0192), answered and failing as a machine call does. A
   * machine whose welcome didn't say it takes them is sent nothing: it would end the stream.
   */
  transfer(
    target: RelayTarget,
    request: TransferRelayRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    return this.exchange(
      target,
      (id, timeoutMs) => ({ type: "machine.transfer", id, request, timeoutMs }),
      options,
      (stream) => {
        if (!stream.transfers)
          throw new TransfersNotOffered("offline", undefined, transfersNotOffered);
      },
    );
  }
  private async exchange(
    target: RelayTarget,
    frame: (id: number, timeoutMs: number) => ClientMessage,
    options: { timeoutMs: number; signal?: AbortSignal },
    admit?: (stream: Stream) => void,
  ): Promise<unknown> {
    if (!this.deps.current(target))
      throw new MachineUnpaired("offline", undefined, "Machine call never sent: unpaired");
    let stream: Stream;
    const key = this.key(target);
    const waiter = { signal: options.signal };
    const waiters = this.waiting.get(key) ?? new Set();
    waiters.add(waiter);
    this.waiting.set(key, waiters);
    try {
      stream = await this.stream(target);
    } catch (error) {
      throw (error instanceof MachineFailure && error.kind === "refused") ||
        error instanceof MachineNotSent
        ? error
        : new MachineFailure("offline");
    } finally {
      waiters.delete(waiter);
      if (!waiters.size && this.waiting.get(key) === waiters) this.waiting.delete(key);
    }
    try {
      // Set-up took time: a caller that gave up, or a pairing removed meanwhile, sends nothing.
      if (options.signal?.aborted)
        throw new MachineNotSent("offline", undefined, "Stopped before it was sent");
      if (!this.deps.current(target))
        throw new MachineUnpaired("offline", undefined, "Machine call never sent: unpaired");
      admit?.(stream);
    } catch (error) {
      // Nothing was sent: an unused stream still closes when idle.
      if (stream.pending.size === 0 && !stream.stopIdle)
        stream.stopIdle = this.deps.schedule(IDLE_MS, () => stream.channel.close());
      throw error;
    }
    stream.stopIdle?.();
    stream.stopIdle = undefined;
    const id = stream.next++;
    const answer = await new Promise<MachineRelayAnswer>((resolve, reject) => {
      const done = () => {
        stopTimer();
        options.signal?.removeEventListener("abort", abort);
      };
      // The caller stops waiting: the machine is told to stop it too.
      const giveUp = () => void stream.channel.send({ type: "machine.cancel", id }).catch(() => {});
      const stopTimer = this.deps.schedule(options.timeoutMs, () => {
        stream.pending.delete(id);
        done();
        giveUp();
        reject(new MachineTimeout("disconnected", undefined, "Machine answer timed out"));
      });
      const abort = () => {
        stream.pending.delete(id);
        done();
        giveUp();
        reject(new MachineFailure("disconnected"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      stream.pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      // Past this the machine stops it rather than run it after the caller gave up.
      const timeoutMs = Math.min(3_600_000, Math.max(1, Math.ceil(options.timeoutMs)));
      stream.channel.send(frame(id, timeoutMs)).catch(() => {
        stream.pending.delete(id);
        done();
        reject(new MachineFailure("offline"));
      });
    });
    if (stream.pending.size === 0)
      stream.stopIdle = this.deps.schedule(IDLE_MS, () => stream.channel.close());
    const { status, body: reply } = answer;
    if (status === 200) return reply;
    const refusal = MachineRefusal.safeParse(reply);
    throw new MachineFailure(
      "refused",
      refusal.success ? refusal.data.error : status === 401 ? "unauthorized" : "unavailable",
      refusal.success ? refusal.data.message : undefined,
      refusal.success && refusal.data.final === true,
    );
  }
  /** Whether any caller waiting on the stream under `key` hasn't given up. */
  private wanted(key: string): boolean {
    for (const waiter of this.waiting.get(key) ?? []) if (!waiter.signal?.aborted) return true;
    return false;
  }
  /** Closes every stream, e.g. at shutdown or when links change. */
  async close(): Promise<void> {
    const open = [...this.streams.values()];
    this.streams.clear();
    for (const opening of open) {
      const stream = await opening.catch(() => undefined);
      stream?.channel.close();
    }
  }
}
