import type { SpadeLiveEndReason } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { onSocketMove } from "./socket-moves.ts";

/*
 * Spade's live streams through the daemon (ADR 0121, `spade.live.*`) on one connection. Every
 * client that reaches Spade through its daemon follows a conversation this way: the web app
 * away from its own machine, and the iPhone always.
 */

/**
 * How a live stream ended. `dropped`: the way it went is gone (the daemon socket dropped or
 * moved, or Spade wasn't at its address); open again, after the last `seq`, once it can.
 */
export type SpadeLiveEnd = SpadeLiveEndReason | "dropped";

export interface SpadeLiveSink {
  frame(event: string, data: string): void;
  /** Called once, unless the stream was closed first. */
  ended(reason: SpadeLiveEnd, status?: number): void;
}

/** What the streams need from the connection. */
export type SpadeLiveOwner = Pick<
  ClientApi,
  "state" | "send" | "onMessage" | "connectionState" | "connectionGeneration"
>;

type Message = Parameters<Parameters<ClientApi["onMessage"]>[0]>[0];

/**
 * The daemon's live streams on one connection. It listens to the connection only while a
 * stream is open or someone waits to open one, and ends every stream as `dropped` when the
 * socket drops or moves, since the daemon ends a socket's streams with it.
 */
export class SpadeDaemonLive {
  private readonly streams = new Map<string, SpadeLiveSink>();
  private readonly openable = new Set<() => void>();
  private stops: (() => void)[] | undefined;
  private readonly client: SpadeLiveOwner;
  private readonly id: () => string;

  constructor(client: SpadeLiveOwner, id: () => string) {
    this.client = client;
    this.id = id;
  }

  /** Whether a stream can open now; a false answer is followed by `onOpenable`. */
  canOpen(): boolean {
    return this.client.state === "ready";
  }

  /** `listener` runs whenever the connection is ready again, or moved to another socket. */
  onOpenable(listener: () => void): () => void {
    this.openable.add(listener);
    this.attach();
    return () => {
      this.openable.delete(listener);
      this.detach();
    };
  }

  /** Opens a live stream (a `/v1/.../live?after=N` path); returns its close. */
  open(path: string, sink: SpadeLiveSink): () => void {
    const requestId = `spade-live-${this.id()}`;
    this.streams.set(requestId, sink);
    this.attach();
    const refuse = (reason: SpadeLiveEnd) =>
      queueMicrotask(() => {
        if (this.streams.delete(requestId)) sink.ended(reason);
      });
    if (!this.stops) refuse("forbidden");
    else if (this.client.state !== "ready") refuse("dropped");
    else
      try {
        this.client.send({ type: "spade.live.subscribe", requestId, path });
      } catch {
        refuse("dropped");
      }
    return () => {
      if (!this.streams.delete(requestId)) return;
      this.detach();
      if (this.client.state !== "ready") return;
      try {
        this.client.send({ type: "spade.live.unsubscribe", requestId });
      } catch {
        // The socket closed first; the daemon ended the stream with it.
      }
    };
  }

  /** Listen to the daemon while anything streams or waits to. */
  private attach() {
    if (this.stops) return;
    const connection = this.client.connectionState();
    const stops: (() => void)[] = [];
    try {
      stops.push(this.client.onMessage((message) => this.receive(message)));
    } catch {
      // At the listener limit: streams can't be followed (`open` says so).
      return;
    }
    stops.push(
      connection.subscribe(() => {
        if (connection.getSnapshot() !== "ready") this.dropAll();
        else this.notify();
      }),
      onSocketMove(this.client, () => {
        this.dropAll();
        this.notify();
      }),
    );
    this.stops = stops;
  }

  private detach() {
    if (this.openable.size || this.streams.size) return;
    for (const stop of this.stops?.splice(0) ?? []) stop();
    this.stops = undefined;
  }

  private receive(message: Message) {
    if (message.type === "spade.live.frame")
      return this.streams.get(message.requestId)?.frame(message.event, message.data);
    if (message.type !== "spade.live.ended") return;
    const sink = this.streams.get(message.requestId);
    if (!sink) return;
    this.streams.delete(message.requestId);
    sink.ended(message.reason, message.status);
  }

  private dropAll() {
    const sinks = [...this.streams.values()];
    this.streams.clear();
    for (const sink of sinks) sink.ended("dropped");
  }

  private notify() {
    for (const listener of this.openable) listener();
  }
}
