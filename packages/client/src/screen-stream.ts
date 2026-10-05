import {
  ScreenClientMessage,
  ScreenOperation,
  ScreenServerMessage,
  ScreenState,
  ScreenStatus,
  type ServerMessage,
} from "@ace/protocol";
import { LatestFrameHub, ScreenFrameReader, type PortableFrame } from "@ace/screen/frames-client";
import { authenticatedChannel, type AuthenticatedChannelOptions } from "./device-transport.ts";
import { ScreenClientError } from "./screen.ts";

export { ScreenClientError } from "./screen.ts";
export type { AuthenticatedChannelOptions } from "./device-transport.ts";
export type { PortableFrame } from "@ace/screen/frames-client";
export { browserDeviceSocket as browserScreenSocket } from "./device-transport.ts";

export interface ScreenTransport {
  open(events: {
    ready(): void;
    message(message: ServerMessage | Uint8Array): void;
    close(): void;
    limited?(error: Error): void;
  }): void;
  send(message: ReturnType<typeof ScreenClientMessage.parse>): void | Promise<void>;
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

/** Dedicated live-view connection. Disconnect rejects pending requests and discards frames;
 * reconnect never replays an input, controller claim or subscription. Import this lazy subpath
 * when mounting the computer-use UI, independently of the main client worker. */
export class ScreenStreamClient {
  private readonly options: ScreenStreamClientOptions;
  private transport: ScreenTransport | undefined;
  private epoch = 0;
  private snapshot: ScreenStreamSnapshot = { connected: false, states: [] };
  private readonly listeners = new Set<(snapshot: ScreenStreamSnapshot) => void>();
  private readonly states = new Map<string, ScreenState>();
  private readonly pending = new Map<string, Pending>();
  private readonly frames = new Map<string, LatestFrameHub<PortableFrame>>();
  private readonly reader: ScreenFrameReader;
  private readonly frameEpochs = new WeakMap<PortableFrame, number>();
  constructor(options: ScreenStreamClientOptions) {
    this.options = options;
    this.reader = new ScreenFrameReader((frame) => {
      this.frameEpochs.set(frame, this.epoch);
      if (this.states.get(frame.header.sessionId)?.lifecycle === "live")
        this.frames.get(frame.header.sessionId)?.publish(frame);
    });
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
    this.reader.reset();
    this.states.clear();
    for (const hub of this.frames.values()) hub.discardPending();
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
        () => finish(failure("timeout", "Screen request timed out")),
        options.timeoutMs ??
          (operation.op === "mode" && operation.mode === "foreground" ? 65_000 : 15_000),
      );
      this.pending.set(requestId, {
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
  watchFrames(
    sessionId: string,
    listener: (frame: PortableFrame) => void | Promise<void>,
  ): () => void {
    let hub = this.frames.get(sessionId);
    if (!hub) {
      if (this.frames.size >= 8) throw failure("busy", "Screen frame subscription limit");
      hub = new LatestFrameHub<PortableFrame>();
      this.frames.set(sessionId, hub);
    }
    const stop = hub.subscribe(async (frame) => {
      if (
        this.frameEpochs.get(frame) === this.epoch &&
        this.states.get(sessionId)?.lifecycle === "live"
      )
        await listener(frame);
    });
    // A hub may have other subscribers; retain it until all consumers leave.
    const slot = hub;
    const count = (this.frameCounts.get(sessionId) ?? 0) + 1;
    this.frameCounts.set(sessionId, count);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      stop();
      const remaining = (this.frameCounts.get(sessionId) ?? 1) - 1;
      if (remaining === 0) {
        slot.clear();
        this.frames.delete(sessionId);
        this.frameCounts.delete(sessionId);
      } else this.frameCounts.set(sessionId, remaining);
    };
  }
  private readonly frameCounts = new Map<string, number>();
  private receive(message: ServerMessage | Uint8Array): void {
    if (message instanceof Uint8Array) {
      this.reader.push(message);
      return;
    }
    const decoded = ScreenServerMessage.safeParse(message);
    if (!decoded.success) return;
    const frame = decoded.data;
    if (frame.type === "screen.enabled") this.publish({ ...this.snapshot, enabled: frame.enabled });
    else if (frame.type === "screen.state") this.putState(frame.state);
    else {
      const request = this.pending.get(frame.requestId);
      if (!request) return;
      this.pending.delete(frame.requestId);
      request.cancel();
      if (!frame.ok) request.reject(new ScreenClientError(frame));
      else {
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
      this.frames.get(state.sessionId)?.discardPending();
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
