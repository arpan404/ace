import { DeviceClient, authenticatedChannel, ephemeralRelayKeys } from "@ace/client/devices";
import type { Credential } from "@ace/client";
import { DeviceOperation, DeviceAck } from "@ace/protocol";
import { z } from "zod";
import { nativePortableSocket } from "./socket.ts";
import { scheduler } from "./host.ts";
import type { TrustMonitor } from "./access.ts";

const noop = () => {};

export const NativeDeviceRequest = z.object({
  type: z.literal("devices.request"),
  operation: DeviceOperation,
});
export const NativeDeviceControl = z.discriminatedUnion("type", [
  DeviceAck,
  z.object({ type: z.literal("native.devices.close") }),
]);

/** The shared authenticated devices channel. Input is never queued or replayed. */
export class NativeDevices {
  readonly client: DeviceClient;
  #connect: () => void;
  #opening: Promise<void> | undefined;
  #cancelOpening: (() => void) | undefined;
  #ack: ((value: z.infer<typeof DeviceAck>) => Promise<void>) | undefined;
  constructor(config: {
    deviceId: string;
    hostId: string;
    credential: () => Promise<Credential>;
    id: () => string;
    trust: TrustMonitor;
  }) {
    this.client = new DeviceClient({
      id: config.id,
      schedule: (callback, delay) => scheduler.set(delay, callback),
    });
    this.#connect = () => {
      const channel = authenticatedChannel(
        {
          // Swift binds every socket to this runtime's pinned machine, never a caller's URL.
          target: { kind: "local", url: "wss://native.invalid" },
          expectedHostId: config.hostId,
          deviceId: config.deviceId,
          credential: config.credential,
          socket: () => nativePortableSocket(config.trust),
          keys: ephemeralRelayKeys,
          schedule: (callback, delay) => scheduler.set(delay, callback),
        },
        "devices",
      );
      this.#ack = (value) => channel.send(value);
      this.client.connect(channel);
    };
  }
  async request(operation: z.infer<typeof DeviceOperation>, signal: AbortSignal): Promise<unknown> {
    if (!this.client.getSnapshot().connected) {
      this.#opening ??= this.#open().finally(() => {
        this.#opening = undefined;
      });
      await this.#opening;
    }
    signal.throwIfAborted();
    // Pixels travel through the native socket and must never cross JSON/JSC.
    if (operation.op === "screenshot") throw new Error("Use the native live view");
    return this.client.request(operation);
  }
  handle(action: z.infer<typeof NativeDeviceControl>): void {
    if (action.type === "native.devices.close") {
      this.#cancelOpening?.();
      this.client.disconnect();
      this.#ack = undefined;
    } else void this.#ack?.(action).catch(() => {});
  }
  #open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let stop = noop;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cancel();
        stop();
        this.#cancelOpening = undefined;
        if (error) reject(error);
        else resolve();
      };
      const cancel = scheduler.set(20_000, () => {
        finish(new Error("Devices disconnected. Check the machine connection and retry."));
        this.client.disconnect();
      });
      this.#cancelOpening = () => finish(new Error("Device view closed"));
      this.#connect();
      stop = this.client.watch((snapshot) => {
        if (snapshot.connected) finish();
        else if (snapshot.error) finish(snapshot.error);
      });
      if (settled) stop();
    });
  }
}
