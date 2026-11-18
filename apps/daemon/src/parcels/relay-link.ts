import {
  DeviceId,
  MachineRefusal,
  type MachineCallRequest,
  type MachineRelayAnswer,
} from "@ace/protocol";
import type { ClientChannel } from "@ace/relay";
import { MachineFailure, MachineTimeout, MachineUnpaired } from "../machines/transport.ts";

/** What opening a relay stream to a machine needs; `connect` is `connectClientViaRelay`. */
export interface RelayLinkDeps {
  connect(options: {
    relayUrl: string;
    hostId: string;
    pinnedFingerprint: string;
    grant?: string;
    signal?: AbortSignal;
  }): Promise<ClientChannel>;
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
  constructor(deps: RelayLinkDeps) {
    this.deps = deps;
  }
  private key(target: RelayTarget) {
    return `${target.url}\n${target.relayHostId}\n${target.deviceId}`;
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
        signal: opening.signal,
      });
    } catch (error) {
      stopDeadline();
      throw error;
    }
    const late = () => channel.close();
    opening.signal.addEventListener("abort", late, { once: true });
    try {
      // Both ends hold to a window the other has consumed (ADR 0110), so a slow reader here
      // holds back the machine instead of filling the relay.
      channel.flowControl?.();
      await channel.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse(target.deviceId),
        token: target.token,
        channel: "machine",
        flowControl: ["credit"],
      });
      const welcome = await channel.receive();
      if (welcome.type !== "welcome")
        throw new MachineFailure("refused", "unauthorized", "The machine refused this link");
    } catch (error) {
      channel.close();
      throw error instanceof MachineFailure ? error : new MachineFailure("offline");
    } finally {
      stopDeadline();
      opening.signal.removeEventListener("abort", late);
    }
    const stream: Stream = { channel, pending: new Map(), next: 1, dead: false };
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
  async call(
    target: RelayTarget,
    body: MachineCallRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (!this.deps.current(target))
      throw new MachineUnpaired("offline", undefined, "Machine call never sent: unpaired");
    let stream: Stream;
    try {
      stream = await this.stream(target);
    } catch (error) {
      throw error instanceof MachineFailure && error.kind === "refused"
        ? error
        : new MachineFailure("offline");
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
      stream.channel.send({ type: "machine.call", id, request: body, timeoutMs }).catch(() => {
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
