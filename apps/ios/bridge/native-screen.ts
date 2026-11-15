import { ScreenClientError, ScreenStreamClient } from "@ace/client/screen-stream";
import { ScreenAck, ScreenOperation, ScreenState } from "@ace/protocol";
import { z } from "zod";
import type { MediaRoute } from "@ace/browser/live-view";
import { scheduler } from "./host.ts";
import { HeldStreams } from "./held-streams.ts";
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
  /** The apps this phone watches live; the shared client decides how their pictures arrive. */
  readonly #streams: HeldStreams;
  readonly client: ScreenStreamClient;
  readonly connection: NativeFeatureConnection;
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
    this.#streams = new HeldStreams(this.client);
    this.connection = new NativeFeatureConnection({
      state: () => this.client.getSnapshot(),
      watch: (listener) => this.client.watch(listener),
      end: () => this.client.disconnect(),
      begin: () => {
        this.client.connect(nativeFeatureChannel(config, "screen"));
      },
    });
  }
  /** Take the apps' pictures by this media connection while it has a binding (ADR 0147 §4). */
  useMedia(route: MediaRoute | undefined): void {
    this.#streams.useMedia(route);
  }
  async request(raw: z.infer<typeof NativeScreenRequest>, signal: AbortSignal): Promise<unknown> {
    await this.connection.ready(signal);
    if (raw.type === "screen.request") {
      // A watching view holds the stream; the shared client subscribes it, on the media
      // connection when there is one, and again whenever that changes.
      if (raw.operation.op === "subscribe") {
        this.#streams.hold(raw.operation.sessionId);
        return null;
      }
      return this.client.request(raw.operation, { signal });
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
      this.#streams.clear();
    } else if (action.type === "screen.ack") {
      this.#streams.ack(
        action.sessionId,
        action.streamId,
        action.sequence,
        action.keyframe === true,
      );
      if (action.fallback) this.#streams.fallBack();
    } else if (action.type === "native.screen.unwatch") {
      this.#streams.release(action.sessionId);
    } else if (this.client.getSnapshot().connected) {
      const operation = { op: "controller" as const, sessionId: action.sessionId };
      void this.client.request({ ...operation, controller: "none" }).catch(() => {});
    }
  }
}
