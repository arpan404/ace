import { onSocketMove, type ClientApi } from "@ace/client";
import { spadeExchange, type SpadeExchange } from "@ace/client/spade-http";
import type { SpadeLiveEndReason } from "@ace/protocol";
import { desktopSpade, type DesktopSpade, type DirectAnswer } from "./desktop-spade.ts";
import { afterLook, afterUnreachable, spadePath, type DirectRoute } from "./spade-route.ts";

/** A body as it came back: text, base64 from the daemon, or bytes from the direct path. */
export type SpadeBody = { text: string } | { base64: string } | { bytes: Uint8Array };

export type SpadeReply =
  | { kind: "response"; status: number; contentType: string | undefined; body: SpadeBody }
  /** `failed`: no answer came back, so Spade may have the request. */
  | { kind: "error"; code: string; message: string };

/**
 * How a live stream ended. `dropped`: the way it went is gone (the daemon socket dropped or
 * moved, or Spade wasn't at its address); open again, after the last `seq`, once `canOpen`.
 */
export type LiveEnd = SpadeLiveEndReason | "dropped";
export interface LiveSink {
  frame(event: string, data: string): void;
  /** Called once, unless the stream was closed first. */
  ended(reason: LiveEnd, status?: number): void;
}

export interface TransportDeps {
  id(): string;
  now(): number;
}

/**
 * Spade's API for the screens, by whichever way works: straight to Spade through the desktop
 * app's main process (ADR 0123) when it knows one, else through the daemon. Screens and the
 * live follow see one interface either way.
 */
export class SpadeTransport {
  private route: DirectRoute = { state: "unknown" };
  private looking: Promise<void> | undefined;
  private readonly openable = new Set<() => void>();
  private readonly daemonStreams = new Map<string, LiveSink>();
  private readonly directStreams = new Map<string, LiveSink>();
  private daemonStops: (() => void)[] | undefined;
  private readonly client: ClientApi;
  readonly desktop: DesktopSpade | undefined;
  private readonly deps: TransportDeps;

  constructor(client: ClientApi, desktop: DesktopSpade | undefined, deps: TransportDeps) {
    this.client = client;
    this.desktop = desktop;
    this.deps = deps;
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

  /** Spade's `/health` straight from Spade: undefined outside the desktop app. */
  async health(): Promise<{ version: string | undefined } | null | undefined> {
    if (!this.desktop) return undefined;
    return this.desktop.health().catch(() => null);
  }

  /** Whether a live stream can open now; a false answer is followed by `onOpenable`. */
  canOpen(): boolean {
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
    this.attachDaemon();
    return () => {
      this.openable.delete(listener);
      this.detachDaemon();
    };
  }

  /** Opens a live stream (a `/v1/.../live?after=N` path); returns its close. */
  open(path: string, sink: LiveSink): () => void {
    return this.route.state === "up" ? this.openDirect(path, sink) : this.openDaemon(path, sink);
  }

  private async path(): Promise<"direct" | "daemon"> {
    if (!this.desktop) return "daemon";
    if (spadePath(this.route, this.deps.now()) === "look") await this.look();
    return spadePath(this.route, this.deps.now()) === "direct" ? "direct" : "daemon";
  }

  private look(): Promise<void> {
    const desktop = this.desktop;
    if (!desktop) return Promise.resolve();
    this.looking ??= desktop
      .available()
      .catch(() => false)
      .then((found) => {
        this.route = afterLook(found, this.deps.now());
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
    const requestId = `spade-live-${this.deps.id()}`;
    this.daemonStreams.set(requestId, sink);
    this.attachDaemon();
    const refuse = (reason: LiveEnd) =>
      queueMicrotask(() => {
        if (this.daemonStreams.delete(requestId)) sink.ended(reason);
      });
    if (!this.daemonStops) refuse("forbidden");
    else if (this.client.state !== "ready") refuse("dropped");
    else
      try {
        this.client.send({ type: "spade.live.subscribe", requestId, path });
      } catch {
        refuse("dropped");
      }
    return () => {
      if (!this.daemonStreams.delete(requestId)) return;
      this.detachDaemon();
      if (this.client.state !== "ready") return;
      try {
        this.client.send({ type: "spade.live.unsubscribe", requestId });
      } catch {
        // The socket closed first; the daemon ended the stream with it.
      }
    };
  }

  /** Listen to the daemon while anything streams or waits to. */
  private attachDaemon() {
    if (this.daemonStops) return;
    const connection = this.client.connectionState();
    const stops: (() => void)[] = [];
    try {
      stops.push(this.client.onMessage((message) => this.receive(message)));
    } catch {
      // At the listener limit: daemon streams can't be followed (`openDaemon` says so).
      return;
    }
    stops.push(
      connection.subscribe(() => {
        // The daemon ends a socket's streams with it.
        if (connection.getSnapshot() !== "ready") this.dropDaemonStreams();
        else this.notifyOpenable();
      }),
      onSocketMove(this.client, () => {
        this.dropDaemonStreams();
        this.notifyOpenable();
      }),
    );
    this.daemonStops = stops;
  }

  private detachDaemon() {
    if (this.openable.size || this.daemonStreams.size) return;
    for (const stop of this.daemonStops?.splice(0) ?? []) stop();
    this.daemonStops = undefined;
  }

  private receive(message: Parameters<Parameters<ClientApi["onMessage"]>[0]>[0]) {
    if (message.type === "spade.live.frame")
      return this.daemonStreams.get(message.requestId)?.frame(message.event, message.data);
    if (message.type !== "spade.live.ended") return;
    const sink = this.daemonStreams.get(message.requestId);
    if (!sink) return;
    this.daemonStreams.delete(message.requestId);
    sink.ended(message.reason, message.status);
  }

  private dropDaemonStreams() {
    const sinks = [...this.daemonStreams.values()];
    this.daemonStreams.clear();
    for (const sink of sinks) sink.ended("dropped");
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
