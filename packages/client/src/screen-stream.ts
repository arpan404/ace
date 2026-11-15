import {
  ScreenAck,
  ScreenClientMessage,
  ScreenOperation,
  ScreenServerMessage,
  ScreenState,
  ScreenStatus,
  type ServerMessage,
} from "@ace/protocol";
import { decodeStreamMessage, isStreamPiece, StreamAssembler } from "@ace/browser/stream";
import {
  channelPath,
  MediaSubscriptions,
  PictureQueue,
  SharedStreams,
  type MediaRoute,
  type Settled,
  type SourcePicture,
} from "@ace/browser/live-view";
import type { MediaPoster } from "@ace/protocol";
import type { PictureChunk, StreamMessage } from "@ace/browser/stream";
import { authenticatedChannel, type AuthenticatedChannelOptions } from "./device-transport.ts";
import { ScreenClientError } from "./screen.ts";

export { ScreenClientError } from "./screen.ts";
export type { AuthenticatedChannelOptions } from "./device-transport.ts";
export type { MediaRoute, SourcePicture } from "@ace/browser/live-view";
export { browserDeviceSocket as browserScreenSocket } from "./device-transport.ts";

export interface ScreenTransport {
  open(events: {
    ready(): void;
    message(message: ServerMessage | Uint8Array): void;
    close(): void;
    limited?(error: Error): void;
  }): void;
  send(message: ReturnType<typeof ScreenClientMessage.parse> | ScreenAck): void | Promise<void>;
  close(): void;
}
/** Authenticated local or encrypted relay socket with hello.channel = screen. */
export function screenTransport(options: AuthenticatedChannelOptions): ScreenTransport {
  return authenticatedChannel(options, "screen");
}
export interface ScreenStreamSnapshot {
  connected: boolean;
  enabled?: boolean;
  states: readonly ScreenState[];
  error?: Error;
}
export interface ScreenStreamClientOptions {
  id(): string;
  schedule(callback: () => void, delayMs: number): () => void;
}
type Pending = {
  /** The session and generation a `subscribe` opened, matched by its reply (`MediaSubscriptions`). */
  subscribe?: { sessionId: string; generation: number };
  resolve(data: unknown): void;
  reject(error: Error): void;
  cancel(): void;
};
function failure(errorCode: "internal" | "busy" | "timeout", error: string): ScreenClientError {
  return new ScreenClientError({
    type: "screen.result",
    requestId: "local",
    ok: false,
    errorCode,
    error,
  });
}

/** Dedicated live-view connection. Disconnect rejects pending requests and discards pictures;
 * reconnect never replays an input, controller claim or subscription. A session's pictures
 * arrive as stream kind `screenFrame` and are acked as shown (`ack`). Import this lazy subpath
 * when mounting the computer-use UI, independently of the main client worker. */
export class ScreenStreamClient {
  private readonly options: ScreenStreamClientOptions;
  private transport: ScreenTransport | undefined;
  private epoch = 0;
  private snapshot: ScreenStreamSnapshot = { connected: false, states: [] };
  private readonly listeners = new Set<(snapshot: ScreenStreamSnapshot) => void>();
  private readonly states = new Map<string, ScreenState>();
  private readonly pending = new Map<string, Pending>();
  /** Stream kind messages (`@ace/browser/stream`) being put back together. */
  private readonly assembler = new StreamAssembler();
  private readonly pictures = new PictureQueue(8);
  /** Which sessions' pictures come by the media connection (ADR 0147 §4). */
  private readonly media = new MediaSubscriptions();
  private stopMedia: (() => void) | undefined;
  constructor(options: ScreenStreamClientOptions) {
    this.options = options;
  }
  /**
   * Take live pictures by this media connection when it has a binding: each held stream
   * subscribes again whenever the binding changes, acks follow the pictures, and requests and
   * state stay on this channel. `undefined` goes back to the channel alone.
   */
  useMedia(route: MediaRoute | undefined): void {
    this.stopMedia?.();
    this.stopMedia = undefined;
    this.media.use(route);
    if (!route) return;
    const stops = [
      route.watch(() => {
        if (!this.snapshot.connected) return;
        for (const sessionId of this.streams.held()) this.subscribe(sessionId);
      }),
      route.onStream((message) => this.receiveMedia(message)),
    ];
    this.stopMedia = () => {
      for (const stop of stops) stop();
    };
  }
  /**
   * The view of `sessionId` couldn't decode `codec` (HEVC, say): that one stream subscribes again
   * without it, while every other source keeps the codecs it plays. False when nothing is left
   * to fall back to (H.264 itself failed).
   */
  fallBack(sessionId: string, codec: string): boolean {
    if (!this.media.fallBack(sessionId, codec)) return false;
    if (this.streams.held().includes(sessionId)) this.subscribe(sessionId);
    return true;
  }
  /** The still the session's subscribe brought back, to show until its first live picture. */
  poster(sessionId: string): MediaPoster | undefined {
    return this.media.poster(sessionId);
  }
  getSnapshot(): ScreenStreamSnapshot {
    return this.snapshot;
  }
  watch(listener: (snapshot: ScreenStreamSnapshot) => void): () => void {
    if (this.listeners.size >= 64) throw failure("busy", "Screen listener limit");
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }
  connect(transport: ScreenTransport): void {
    this.disconnect();
    this.transport = transport;
    const epoch = this.epoch;
    transport.open({
      ready: () => {
        if (this.epoch === epoch) this.publish({ ...this.snapshot, connected: true });
      },
      message: (message) => {
        if (this.epoch !== epoch) return;
        try {
          this.receive(message);
        } catch (error) {
          this.disconnect(
            error instanceof Error ? error : failure("internal", "Invalid screen frame"),
          );
        }
      },
      close: () => {
        if (this.epoch === epoch) this.disconnect();
      },
      limited: (error) => {
        if (this.epoch === epoch) this.publish({ ...this.snapshot, error });
      },
    });
  }
  disconnect(error: Error = failure("internal", "Screen connection closed")): void {
    this.epoch++;
    const transport = this.transport;
    this.transport = undefined;
    transport?.close();
    this.assembler.reset();
    this.states.clear();
    this.streams.reset();
    this.media.reset();
    this.pictures.discard();
    for (const request of this.pending.values()) {
      request.cancel();
      request.reject(error);
    }
    this.pending.clear();
    this.publish({ connected: false, states: [], ...(transport ? { error } : {}) });
  }
  request(
    operation: ScreenOperation,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return this.send(operation, options, undefined);
  }
  private send(
    operation: ScreenOperation,
    options: { timeoutMs?: number; signal?: AbortSignal },
    generation: number | undefined,
  ): Promise<unknown> {
    if (!this.snapshot.connected || !this.transport)
      return Promise.reject(failure("internal", "Screen connection is not ready"));
    if (this.pending.size >= 32) return Promise.reject(failure("busy", "Screen request limit"));
    const requestId = this.options.id();
    if (this.pending.has(requestId))
      return Promise.reject(failure("busy", "Duplicate screen request id"));
    const message = ScreenClientMessage.parse({
      type: "screen.request",
      requestId,
      operation: ScreenOperation.parse(operation),
    });
    const transport = this.transport;
    return new Promise((resolve, reject) => {
      const finish = (error: Error) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.cancel();
        reject(error);
      };
      const abort = () => finish(failure("internal", "Screen request aborted"));
      const cancelTimer = this.options.schedule(
        () => {
          if (
            generation !== undefined &&
            operation.op === "subscribe" &&
            this.pending.has(requestId)
          )
            this.timedOut(requestId, operation.sessionId, generation);
          finish(failure("timeout", "Screen request timed out"));
        },
        options.timeoutMs ?? defaultTimeoutMs(operation),
      );
      this.pending.set(requestId, {
        ...(operation.op === "subscribe" && generation !== undefined
          ? { subscribe: { sessionId: operation.sessionId, generation } }
          : {}),
        resolve,
        reject,
        cancel: () => {
          cancelTimer();
          options.signal?.removeEventListener("abort", abort);
        },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      try {
        void Promise.resolve(transport.send(message)).catch((error: unknown) =>
          finish(error instanceof Error ? error : failure("internal", "Screen send failed")),
        );
      } catch (error) {
        finish(error instanceof Error ? error : failure("internal", "Screen send failed"));
      }
    });
  }
  /**
   * A session's live pictures, in order, while it is live. Ack each with `ack` once shown (or
   * at once when it can't be): the daemon sends a window's worth ahead of the acks and no more.
   */
  watchPictures(
    sessionId: string,
    draw: (picture: SourcePicture) => void | Promise<void>,
  ): () => void {
    try {
      return this.pictures.watch(sessionId, async (picture) => {
        if (this.snapshot.connected && this.states.get(sessionId)?.lifecycle === "live")
          await draw(picture);
      });
    } catch {
      throw failure("busy", "Screen frame subscription limit");
    }
  }
  /**
   * The view showed `picture` (and every one before it); `keyframe`: its decoder lost its place.
   * Never answered and never retried: a lost ack only holds the stream until the next one.
   */
  ack(picture: SourcePicture, keyframe = false): void {
    const transport = this.transport;
    if (picture.still || !transport || !this.snapshot.connected) return;
    const message: ScreenAck = {
      type: "screen.ack",
      sessionId: picture.sourceId,
      streamId: picture.streamId,
      sequence: picture.sequence,
      ...(keyframe ? { keyframe: true as const } : {}),
    };
    const way = this.media.way(picture.sourceId, picture.generation);
    // A picture of an earlier subscribe: its ack belongs to a delivery that is gone.
    if (way === "stale") return;
    if (way === "media") return void this.media.route?.ack(message);
    try {
      void Promise.resolve(transport.send(message)).catch(() => {});
    } catch {
      /* The channel is closing; its close resets the view. */
    }
  }
  private readonly streams = new SharedStreams();
  /** Whether `picture` is of its source's current subscribe: an older one is never drawn. */
  current(picture: SourcePicture): boolean {
    return this.media.current(picture.sourceId, picture.generation);
  }
  /**
   * A subscribe of `sessionId` failed: try again after the bounded backoff, unless the channel
   * closed, nothing holds the stream any more or another subscribe went out meanwhile.
   */
  private retryLater(sessionId: string): void {
    const delay = this.media.retryDelay(sessionId);
    if (delay === undefined) return;
    const epoch = this.epoch;
    const generation = this.media.generation(sessionId);
    this.options.schedule(() => {
      if (this.epoch !== epoch || this.media.generation(sessionId) !== generation) return;
      if (this.streams.held().includes(sessionId)) this.subscribe(sessionId);
    }, delay);
  }
  private subscribe(sessionId: string): void {
    const { generation, fields } = this.media.begin(sessionId);
    // What the earlier subscribe delivered and nobody drew yet is stale now.
    this.pictures.discardSource(sessionId);
    void this.send({ op: "subscribe", sessionId, ...fields }, {}, generation).catch(
      (error: unknown) => {
        const next = this.media.failed(sessionId, generation, error);
        // A connection the daemon won't bind here: the stream goes on this channel instead.
        if (next === "resubscribe") return this.subscribe(sessionId);
        if (next === "retry") this.retryLater(sessionId);
      },
    );
  }
  /**
   * Keep `sessionId`'s live stream open for one view. Views of the same session share one
   * daemon subscription: the first view subscribes, the last to release unsubscribes.
   */
  retainStream(sessionId: string): () => void {
    return this.streams.retain(
      sessionId,
      () => this.subscribe(sessionId),
      () => {
        this.media.forget(sessionId);
        void this.request({ op: "unsubscribe", sessionId }).catch(() => {});
      },
    );
  }
  private receiveMedia(message: StreamMessage): void {
    const connection = this.media.route?.binding()?.connection;
    if (message.kind === "screen.frame" && connection && this.snapshot.connected)
      this.publishPicture(message.sourceId, message.frame, connection);
  }
  /** A live picture that came by `path`, stamped with its delivery's generation, else dropped. */
  private publishPicture(sourceId: string, frame: PictureChunk, path: string): void {
    if (this.states.get(sourceId)?.lifecycle !== "live") return;
    const stamped = this.media.arrive(sourceId, path, frame);
    if (stamped)
      this.pictures.publish({ ...stamped.frame, sourceId, generation: stamped.generation });
  }
  /**
   * What a subscribe's reply released: the pictures that came its settled way while it was on its
   * way, shown now; past the buffer's bounds, the delivery is asked for a fresh keyframe.
   */
  private release(sourceId: string, settled: Settled): void {
    for (const { frame, generation } of settled.pictures)
      this.pictures.publish({ ...frame, sourceId, generation });
    const ask = settled.ask;
    if (ask) this.ack({ ...ask.frame, sourceId, generation: ask.generation }, true);
  }
  /**
   * A subscribe got no answer in time: its source stops waiting (delivery falls back to the
   * channel), and its reply, should it still come, is kept for (`late`), bounded.
   */
  private timedOut(requestId: string, sourceId: string, generation: number): void {
    this.media.abandon(sourceId, generation);
    this.late.set(requestId, { sourceId, generation });
    for (const oldest of this.late.keys()) {
      if (this.late.size <= 32) break;
      this.late.delete(oldest);
    }
  }
  /** Subscribes that timed out, by request id, whose late reply still settles their delivery. */
  private readonly late = new Map<string, { sourceId: string; generation: number }>();

  private receive(message: ServerMessage | Uint8Array): void {
    if (message instanceof Uint8Array) {
      if (!isStreamPiece(message)) throw failure("internal", "Invalid screen frame");
      const envelope = this.assembler.push(message);
      // Kinds this client doesn't draw are skipped, never fatal.
      const decoded = envelope && decodeStreamMessage(envelope);
      if (decoded?.kind === "screen.frame")
        this.publishPicture(decoded.sourceId, decoded.frame, channelPath);
      return;
    }
    const decoded = ScreenServerMessage.safeParse(message);
    if (!decoded.success) return;
    const frame = decoded.data;
    if (frame.type === "screen.enabled") this.publish({ ...this.snapshot, enabled: frame.enabled });
    else if (frame.type === "screen.state") this.putState(frame.state);
    else {
      const request = this.pending.get(frame.requestId);
      const late = request ? undefined : this.late.get(frame.requestId);
      if (late) {
        this.late.delete(frame.requestId);
        if (frame.ok)
          this.release(
            late.sourceId,
            this.media.subscribed(late.sourceId, late.generation, frame.media),
          );
        return;
      }
      if (!request) return;
      this.pending.delete(frame.requestId);
      request.cancel();
      if (!frame.ok) request.reject(new ScreenClientError(frame));
      else {
        const opened = request.subscribe;
        if (opened) {
          this.release(
            opened.sessionId,
            this.media.subscribed(opened.sessionId, opened.generation, frame.media),
          );
          if (this.media.poster(opened.sessionId)) this.publish({ ...this.snapshot });
        }
        try {
          const state = ScreenState.safeParse(frame.data);
          if (state.success) this.putState(state.data);
          const states = ScreenState.array().max(8).safeParse(frame.data);
          if (states.success) {
            this.states.clear();
            for (const item of states.data) this.putState(item);
            this.publish({ ...this.snapshot, states: [...this.states.values()] });
          }
          const status = ScreenStatus.safeParse(frame.data);
          if (status.success) this.publish({ ...this.snapshot, enabled: status.data.enabled });
          request.resolve(frame.data);
        } catch (error) {
          const problem = error instanceof Error ? error : new Error("Invalid screen state");
          request.reject(problem);
          throw problem;
        }
      }
    }
  }
  private putState(state: ScreenState): void {
    if (state.lifecycle === "stopped" || state.lifecycle === "failed") {
      this.states.delete(state.sessionId);
      this.pictures.discardSource(state.sessionId);
    } else {
      if (!this.states.has(state.sessionId) && this.states.size >= 8)
        throw failure("busy", "Screen state limit");
      this.states.set(state.sessionId, state);
    }
    this.publish({ ...this.snapshot, states: [...this.states.values()] });
  }
  private publish(snapshot: ScreenStreamSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

/**
 * How long a request may take. Bringing an app forward waits for the person to switch; a
 * sharing-dialog start waits up to two minutes for the person at that machine to choose.
 */
function defaultTimeoutMs(operation: ScreenOperation): number {
  if (operation.op === "mode" && operation.mode === "foreground") return 65_000;
  if (operation.op === "start" && operation.target.kind === "chooser") return 140_000;
  return 15_000;
}
