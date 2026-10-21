import { ScreenStreamClient } from "@ace/client/screen-stream";
import { ScreenAck, ScreenOperation } from "@ace/protocol";
import { z } from "zod";
import { scheduler } from "./host.ts";
import {
  nativeFeatureChannel,
  NativeFeatureConnection,
  type NativeFeatureConfig,
} from "./native-feature-channel.ts";

export const NativeScreenRequest = z.object({
  type: z.literal("screen.request"),
  operation: ScreenOperation,
});
export const NativeScreenControl = z.discriminatedUnion("type", [
  ScreenAck,
  z.object({ type: z.literal("native.screen.close") }),
  z.object({ type: z.literal("native.screen.unwatch"), sessionId: ScreenAck.shape.sessionId }),
  z.object({ type: z.literal("native.screen.release"), sessionId: ScreenAck.shape.sessionId }),
]);

/** A dedicated screen channel. Native video bypasses JavaScript and input is never replayed. */
export class NativeScreen {
  readonly client: ScreenStreamClient;
  readonly connection: NativeFeatureConnection;
  #ack: ((value: z.infer<typeof ScreenAck>) => Promise<void>) | undefined;
  constructor(config: NativeFeatureConfig) {
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
  async request(operation: z.infer<typeof ScreenOperation>, signal: AbortSignal): Promise<unknown> {
    await this.connection.ready(signal);
    return this.client.request(operation, { signal });
  }
  handle(action: z.infer<typeof NativeScreenControl>): void {
    if (action.type === "native.screen.close") {
      this.connection.close();
      this.#ack = undefined;
    } else if (action.type === "screen.ack") void this.#ack?.(action).catch(() => {});
    else if (this.client.getSnapshot().connected) {
      const operation =
        action.type === "native.screen.unwatch"
          ? { op: "unsubscribe" as const, sessionId: action.sessionId }
          : { op: "controller" as const, sessionId: action.sessionId, controller: "none" as const };
      void this.client.request(operation).catch(() => {});
    }
  }
}
