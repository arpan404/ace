import { nativeVideoCodecs } from "./video-codecs.ts";
import { ScreenClientError, ScreenStreamClient } from "@ace/client/screen-stream";
import { ScreenAck, ScreenOperation, ScreenState } from "@ace/protocol";
import { z } from "zod";
import type { MediaRoute } from "@ace/browser/live-view";
import { scheduler } from "./host.ts";
import { MediaViews } from "./media-views.ts";
import { phoneScreenSessions, type ScreenAgentLabel } from "./screen-view.ts";
import {
  nativeFeatureChannel,
  NativeFeatureConnection,
  type NativeFeatureConfig,
} from "./native-feature-channel.ts";

export const NativeScreenRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("screen.request"), operation: ScreenOperation }),
  /** Every app shown, agent-held first, worded as the web words them (`screenSession`). */
  z.object({ type: z.literal("screen.sessions") }),
]);

export const NativeScreenControl = z.discriminatedUnion("type", [
  ScreenAck.extend({ fallback: z.boolean().optional() }),
  z.object({ type: z.literal("native.screen.close") }),
  z.object({ type: z.literal("native.screen.unwatch"), sessionId: ScreenAck.shape.sessionId }),
  z.object({ type: z.literal("native.screen.release"), sessionId: ScreenAck.shape.sessionId }),
]);

/**
 * A refused screen request as the phone reads it: the daemon's words and, when it gave one, its
 * code, so the phone can tell "input sent, effect unconfirmed" from losing control.
 */
export function screenFailure(error: unknown): { message: string; code?: string } {
  const message = error instanceof Error ? error.message : "Screen request failed";
  return error instanceof ScreenClientError && error.errorCode
    ? { message, code: error.errorCode }
    : { message };
}

/** A dedicated screen channel. Native video bypasses JavaScript and input is never replayed. */
export class NativeScreen {
  #h264Only = new Set<string>();
  /** Which apps' pictures come by the media connection, and where their acks go. */
  readonly #views = new MediaViews((sessionId) => {
    if (!this.client.getSnapshot().connected) return;
    void this.client.request(this.#subscribe({ sessionId })).catch(() => {});
  });
  readonly client: ScreenStreamClient;
  readonly connection: NativeFeatureConnection;
  #ack: ((value: z.infer<typeof ScreenAck>) => Promise<void>) | undefined;
  readonly label: ScreenAgentLabel;
  readonly #machine: () => Promise<string | undefined>;
  constructor(
    config: NativeFeatureConfig,
    label: ScreenAgentLabel = () => undefined,
    /** The computer's name, for words about its own sharing dialog. */
    machine: () => Promise<string | undefined> = async () => undefined,
  ) {
    this.label = label;
    this.#machine = machine;
    this.client = new ScreenStreamClient({
      id: config.id,
      schedule: (callback, delay) => scheduler.set(delay, callback),
    });
    this.connection = new NativeFeatureConnection({
      state: () => this.client.getSnapshot(),
      watch: (listener) => this.client.watch(listener),
      end: () => this.client.disconnect(),
      begin: () => {
        const channel = nativeFeatureChannel(config, "screen");
        this.#ack = (value) => channel.send(value);
        this.client.connect(channel);
      },
    });
  }
  /** Take the apps' pictures by this media connection while it has a binding (ADR 0147 §4). */
  useMedia(route: MediaRoute | undefined): void {
    this.#views.use(route);
  }
  /** A watching view's subscribe: this phone's decoders, and the media connection if open. */
  #subscribe<T extends { sessionId: string }>(operation: T) {
    return {
      ...operation,
      op: "subscribe" as const,
      codecs: this.#h264Only.has(operation.sessionId) ? ["avc1.42E033"] : nativeVideoCodecs(),
      ...this.#views.subscribe(operation.sessionId),
    };
  }
  async request(raw: z.infer<typeof NativeScreenRequest>, signal: AbortSignal): Promise<unknown> {
    await this.connection.ready(signal);
    if (raw.type === "screen.request") {
      const operation =
        raw.operation.op === "subscribe" ? this.#subscribe(raw.operation) : raw.operation;
      return this.client.request(operation, { signal });
    }
    const states = z
      .array(ScreenState)
      .parse(await this.client.request({ op: "sessions" }, { signal }));
    const machine = await this.#machine().catch(() => undefined);
    return { sessions: phoneScreenSessions(states, this.label, machine) };
  }
  handle(action: z.infer<typeof NativeScreenControl>): void {
    if (action.type === "native.screen.close") {
      this.connection.close();
      this.#ack = undefined;
      this.#views.reset();
    } else if (action.type === "screen.ack") {
      const { fallback, ...wire } = action;
      if (!this.#views.ack(action.sessionId, wire)) void this.#ack?.(wire).catch(() => {});
      if (fallback && !this.#h264Only.has(action.sessionId)) {
        this.#h264Only.add(action.sessionId);
        const operation = this.#subscribe({ sessionId: action.sessionId });
        void this.client.request(operation).catch(() => {});
      }
    } else if (this.client.getSnapshot().connected) {
      if (action.type === "native.screen.unwatch") this.#views.forget(action.sessionId);
      const operation =
        action.type === "native.screen.unwatch"
          ? { op: "unsubscribe" as const, sessionId: action.sessionId }
          : { op: "controller" as const, sessionId: action.sessionId, controller: "none" as const };
      void this.client.request(operation).catch(() => {});
    }
  }
}
