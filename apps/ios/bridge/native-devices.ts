import { DeviceClient } from "@ace/client/devices";
import { DeviceOperation, DeviceAck } from "@ace/protocol";
import { z } from "zod";
import { scheduler } from "./host.ts";
import {
  nativeFeatureChannel,
  NativeFeatureConnection,
  type NativeFeatureConfig,
} from "./native-feature-channel.ts";

export const NativeDeviceRequest = z.object({
  type: z.literal("devices.request"),
  operation: DeviceOperation,
});
export const NativeDeviceControl = z.discriminatedUnion("type", [
  DeviceAck,
  z.object({ type: z.literal("native.devices.close") }),
  z.object({ type: z.literal("native.devices.unwatch"), deviceId: DeviceAck.shape.deviceId }),
  z.object({ type: z.literal("native.devices.release"), deviceId: DeviceAck.shape.deviceId }),
]);

/** The shared authenticated devices channel. Input is never queued or replayed. */
export class NativeDevices {
  readonly client: DeviceClient;
  readonly connection: NativeFeatureConnection;
  #ack: ((value: z.infer<typeof DeviceAck>) => Promise<void>) | undefined;
  constructor(config: NativeFeatureConfig) {
    this.client = new DeviceClient({
      id: config.id,
      schedule: (callback, delay) => scheduler.set(delay, callback),
    });
    this.connection = new NativeFeatureConnection({
      state: () => this.client.getSnapshot(),
      watch: (listener) => this.client.watch(listener),
      end: () => this.client.disconnect(),
      begin: () => {
        const channel = nativeFeatureChannel(config, "devices");
        this.#ack = (value) => channel.send(value);
        this.client.connect(channel);
      },
    });
  }
  async request(operation: z.infer<typeof DeviceOperation>, signal: AbortSignal): Promise<unknown> {
    await this.connection.ready(signal);
    // Pixels travel through the native socket and must never cross JSON/JSC.
    if (operation.op === "screenshot") throw new Error("Use the native live view");
    return this.client.request(operation);
  }
  handle(action: z.infer<typeof NativeDeviceControl>): void {
    if (action.type === "native.devices.close") {
      this.connection.close();
      this.#ack = undefined;
    } else if (action.type === "devices.ack") void this.#ack?.(action).catch(() => {});
    else if (this.client.getSnapshot().connected) {
      const operation =
        action.type === "native.devices.unwatch"
          ? { op: "unsubscribe" as const, deviceId: action.deviceId }
          : { op: "controller" as const, deviceId: action.deviceId, controller: "none" as const };
      void this.client.request(operation).catch(() => {});
    }
  }
}
