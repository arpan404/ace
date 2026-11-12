import type { ClientApi } from "@ace/client";
import { spadeExchange, type SpadeExchange } from "@ace/client/spade-http";
import { SpadeDaemonLive, type SpadeLiveEnd, type SpadeLiveSink } from "@ace/client/spade-live";
import { desktopSpade, type DesktopSpade, type DirectAnswer } from "./desktop-spade.ts";
import {
  afterLook,
  afterUnreachable,
  isLocalMachine,
  spadePath,
  type DirectRoute,
} from "./spade-route.ts";

/** A body as it came back: text, base64 from the daemon, or bytes from the direct path. */
export type SpadeBody = { text: string } | { base64: string } | { bytes: Uint8Array };

export type SpadeReply =
  | { kind: "response"; status: number; contentType: string | undefined; body: SpadeBody }
  /** `failed`: no answer came back, so Spade may have the request. */
  | { kind: "error"; code: string; message: string };

/** How a live stream ended; `dropped`: open again, after the last `seq`, once `canOpen`. */
export type LiveEnd = SpadeLiveEnd;
export type LiveSink = SpadeLiveSink;

export interface TransportDeps {
  id(): string;
  now(): number;
}

/**
 * Spade's API for the screens, by whichever way works: straight to Spade through the desktop
 * app's main process (ADR 0123) when it knows one and this connection is to the daemon beside
 * it, else through the daemon. Screens and the live follow see one interface either way.
 */
export class SpadeTransport {
  private route: DirectRoute = { state: "unknown" };
  private looking: Promise<void> | undefined;
  /** The daemon's identity beside the app's Spade, from the last look. */
  private spadeHost: string | undefined;
  /**
   * The connected daemon's identity (`host.identity`) and the socket it was read on. Kept while
   * no socket is up, so Spade stays reachable while the daemon is down; read again on a new one.
   */
  private connected: { generation: number; hostId: string } | undefined;
  /** The last socket seen, so a new one is noticed once. */
  private socket: number | undefined;
  private readonly openable = new Set<() => void>();
  private readonly directStreams = new Map<string, LiveSink>();
  /** The daemon's streams, and the moments a stream can open there again. */
  private readonly daemon: SpadeDaemonLive;
  private readonly client: ClientApi;
  readonly desktop: DesktopSpade | undefined;
  private readonly deps: TransportDeps;

  constructor(client: ClientApi, desktop: DesktopSpade | undefined, deps: TransportDeps) {
    this.client = client;
    this.desktop = desktop;
    this.deps = deps;
    this.daemon = new SpadeDaemonLive(client, deps.id);
    desktop?.onEndpointChanged(() => {
      this.route = { state: "unknown" };
      void this.look();
    });
    desktop?.onLive((event) => {
      const sink = this.directStreams.get(event.streamId);
      if (!sink) return;
      if (event.kind === "frame") return sink.frame(event.event, event.data);
      this.directStreams.delete(event.streamId);
      if (event.reason !== "unreachable") return sink.ended(event.reason, event.status);
      this.route = afterUnreachable(this.deps.now());
      sink.ended("dropped");
    });
  }

  /** One request and its whole answer. */
  async exchange(
    exchange: SpadeExchange,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<SpadeReply> {
    // The direct path sends text bodies; anything else goes the daemon's way.
    if ((exchange.encoding ?? "text") === "text" && (await this.path()) === "direct") {
      const reply = await this.direct(exchange, options.signal);
      if (reply) return reply;
    }
    const answer = await spadeExchange(this.client, exchange, {
      id: this.deps.id,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (answer.kind === "error") return answer;
    const { status, contentType, body, encoding } = answer;
    return {
      kind: "response",
      status,
      contentType,
      body: encoding === "base64" ? { base64: body } : { text: body },
    };
  }

  /**
   * Spade's `/health` straight from Spade: undefined outside the desktop app, or when this
   * connection is to another machine than the app's own (then only its daemon can say).
   */
  async health(): Promise<{ version: string | undefined } | null | undefined> {
    const desktop = this.desktop;
    if (!desktop) return undefined;
    this.followSocket();
    if (this.route.state === "unknown") await this.look();
    if (!this.local()) return undefined;
    return desktop.health().catch(() => null);
  }

  /** Whether a live stream can open now; a false answer is followed by `onOpenable`. */
  canOpen(): boolean {
    this.followSocket();
    const path = this.desktop ? spadePath(this.route, this.deps.now()) : "daemon";
    if (path === "look") {
      void this.look();
      // The look is quick; a stream waits for it rather than take the slower way first.
      if (this.route.state === "unknown") return false;
    }
    return path === "direct" || this.client.state === "ready";
  }

  /** `listener` runs whenever a stream may open where it couldn't (or had to reopen). */
  onOpenable(listener: () => void): () => void {
    this.openable.add(listener);
    const stop = this.daemon.onOpenable(listener);
    return () => {
      this.openable.delete(listener);
      stop();
    };
  }

  /** Opens a live stream (a `/v1/.../live?after=N` path); returns its close. */
  open(path: string, sink: LiveSink): () => void {
    return this.route.state === "up" ? this.openDirect(path, sink) : this.openDaemon(path, sink);
  }

  private async path(): Promise<"direct" | "daemon"> {
    if (!this.desktop) return "daemon";
    this.followSocket();
    if (spadePath(this.route, this.deps.now()) === "look") await this.look();
    return spadePath(this.route, this.deps.now()) === "direct" ? "direct" : "daemon";
  }

  private local(): boolean {
    return isLocalMachine(this.spadeHost, this.connected?.hostId);
  }

  /** A new socket may lead to another machine: what the last look found no longer holds. */
  private followSocket() {
    const generation = this.client.connectionGeneration().getSnapshot();
    if (generation === undefined || generation === this.socket) return;
    this.socket = generation;
    if (this.connected?.generation === generation) return;
    this.connected = undefined;
    this.route = { state: "unknown" };
  }

  /** The connected daemon's identity, read once per socket. */
  private async connectedHost(): Promise<string | undefined> {
    const generation = this.client.connectionGeneration().getSnapshot();
    if (generation === undefined || generation === this.connected?.generation)
      return this.connected?.hostId;
    try {
      const reply = await this.client.request({ type: "host.identity" });
      // Only for the socket it was asked on: a move while it was out asks again.
      if (this.client.connectionGeneration().getSnapshot() === generation)
        this.connected = { generation, hostId: reply.identity.hostId };
    } catch {
      // Unknown: the direct path waits until this connection says which machine it is.
    }
    return this.connected?.hostId;
  }

  private look(): Promise<void> {
    const desktop = this.desktop;
    if (!desktop) return Promise.resolve();
    this.looking ??= Promise.all([
      desktop.localHost().catch(() => null),
      this.connectedHost(),
    ]).then(([spadeHost]) => {
      this.spadeHost = spadeHost ?? undefined;
      this.route = afterLook(this.local(), this.deps.now());
      this.looking = undefined;
      this.notifyOpenable();
    });
    return this.looking;
  }

  private async direct(
    exchange: SpadeExchange,
    signal: AbortSignal | undefined,
  ): Promise<SpadeReply | undefined> {
    const desktop = this.desktop;
    if (!desktop) return undefined;
    let answer: DirectAnswer;
    try {
      answer = await abortable(
        desktop.request({
          method: exchange.method,
          path: exchange.path,
          body: exchange.body,
          contentType: exchange.contentType,
        }),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: "error", code: "failed", message: "The app couldn't ask Spade." };
    }
    switch (answer.kind) {
      case "unreachable":
        this.route = afterUnreachable(this.deps.now());
        return undefined;
      case "error":
        return answer;
      case "text":
      case "bytes": {
        const { status, contentType } = answer;
        const body = answer.kind === "text" ? { text: answer.body } : { bytes: answer.body };
        return { kind: "response", status, contentType, body };
      }
    }
  }

  private openDirect(path: string, sink: LiveSink): () => void {
    const desktop = this.desktop;
    if (!desktop) return this.openDaemon(path, sink);
    const streamId = `spade-direct-${this.deps.id()}`;
    this.directStreams.set(streamId, sink);
    desktop.openLive(streamId, path).catch(() => {
      if (!this.directStreams.delete(streamId)) return;
      this.route = afterUnreachable(this.deps.now());
      sink.ended("dropped");
    });
    return () => {
      if (this.directStreams.delete(streamId)) void desktop.closeLive(streamId).catch(() => {});
    };
  }

  private openDaemon(path: string, sink: LiveSink): () => void {
    return this.daemon.open(path, sink);
  }

  private notifyOpenable() {
    for (const listener of this.openable) listener();
  }
}

/** `work`, or a rejection as soon as `signal` aborts (the work itself carries on unread). */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

const transports = new WeakMap<ClientApi, SpadeTransport>();
const defaultDeps: TransportDeps = { id: () => crypto.randomUUID(), now: () => Date.now() };

/** The transport for this connection, with the desktop app's direct path when there is one. */
export function spadeTransport(client: ClientApi): SpadeTransport {
  let transport = transports.get(client);
  if (!transport) {
    transport = new SpadeTransport(client, desktopSpade(), defaultDeps);
    transports.set(client, transport);
  }
  return transport;
}
