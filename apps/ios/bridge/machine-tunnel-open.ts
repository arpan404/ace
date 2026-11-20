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
 * beside the machine connection. It opens with `openMachineTunnel`, not `openPathTunnel`: the
 * phone's lower layer already does what that one adds. Swift binds every bridge socket to the
 * runtime's route and ignores the URL given here, so a direct socket is `PinnedSocket`, held to
 * the paired listener's public-key pin, and a relay one is `RelaySocket`, whose Noise handshake
 * pins the daemon's host key. The paired credential is a one-use ticket from `POST /v1/tickets`
 * under that same pin (`pairedCredential`), so the token never goes on a socket raw, and every
 * welcome must name `expectedHostId`. A runtime keeps one route for its life: a route change
 * replaces the runtime (its device tabs are restored on the next), so the path never switches
 * here. It is there while the machine connection is ready, and gone while it is not.
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
