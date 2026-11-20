import { ephemeralRelayKeys } from "@ace/client/devices";
import {
  openMachineTunnel,
  tunnelChannel,
  type MachineTunnel,
  type TunnelPath,
} from "@ace/client/machine-tunnel";
import { portableReadableStream } from "@ace/native-host";
import { scheduler } from "./host.ts";
import type { NativeFeatureConfig } from "./native-feature-channel.ts";
import { nativePortableSocket } from "./socket.ts";

/*
 * A machine's localhost tunnel for its device tabs (ADR 0194), on a native socket of its own
 * beside the machine connection. Swift binds every socket to the runtime's route (direct, or the
 * relay), and a runtime keeps one route for its life, so the path never switches here: it is
 * there while the machine connection is ready, and gone while it is not.
 */

export interface ConnectionState {
  getSnapshot(): string;
  subscribe(listener: () => void): () => void;
}

export function openPhoneTunnel(
  config: NativeFeatureConfig,
  connection: ConnectionState,
): MachineTunnel {
  const path: TunnelPath = {
    key: "native",
    link: () =>
      tunnelChannel({
        target: { kind: "local", url: "wss://native.invalid" },
        ...(config.expectedHostId === undefined ? {} : { expectedHostId: config.expectedHostId }),
        deviceId: config.deviceId,
        credential: config.credential,
        socket: () => nativePortableSocket(config.trust),
        keys: ephemeralRelayKeys,
        schedule: (callback, delay) => scheduler.set(delay, callback),
      }),
  };
  return openMachineTunnel({
    path: {
      get: () => (connection.getSnapshot() === "ready" ? path : undefined),
      subscribe: (changed) => connection.subscribe(changed),
    },
    schedule: (run, delay) => scheduler.set(delay, run),
    ReadableStream: portableReadableStream,
  });
}
