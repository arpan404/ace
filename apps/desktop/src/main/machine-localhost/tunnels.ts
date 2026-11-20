import {
  openMachineTunnel,
  tunnelChannel,
  type MachineTunnel,
  type TunnelPath,
} from "@ace/client/machine-tunnel";
import { browserDeviceSocket, ephemeralRelayKeys } from "@ace/client/devices";
import type { z } from "zod";
import type { MachineTunnelPath } from "../../shared/device-tabs.ts";

type PathRequest = NonNullable<z.output<typeof MachineTunnelPath>["path"]>;

interface Machine {
  path: TunnelPath | undefined;
  listeners: Set<() => void>;
  tunnel: MachineTunnel | undefined;
}

const schedule = (run: () => void, delayMs: number) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/**
 * Each remote machine's tunnel, opened here in the main process beside its proxy (ADR 0194).
 * The renderer, which holds the machine connection, says which path that connection is on and
 * with which credential; a new path moves new streams there (`openMachineTunnel`). A machine
 * whose path is unknown has no tunnel: its loopback answers as offline.
 */
export class MachineTunnels {
  private machines = new Map<string, Machine>();

  /** The machine connection is on `path` now; undefined while it is offline. */
  setPath(machineId: string, path: PathRequest | undefined): void {
    let machine = this.machines.get(machineId);
    if (!machine) {
      if (!path) return;
      machine = { path: undefined, listeners: new Set(), tunnel: undefined };
      this.machines.set(machineId, machine);
    }
    if (machine.path?.key === path?.key) return;
    machine.path = path && tunnelPath(path);
    for (const listener of machine.listeners) listener();
  }

  tunnel(machineId: string): MachineTunnel | undefined {
    const machine = this.machines.get(machineId);
    if (!machine) return undefined;
    machine.tunnel ??= openMachineTunnel({
      path: {
        get: () => machine.path,
        subscribe: (changed) => {
          machine.listeners.add(changed);
          return () => machine.listeners.delete(changed);
        },
      },
      schedule,
    });
    return machine.tunnel;
  }

  close(): void {
    for (const machine of this.machines.values()) machine.tunnel?.close();
    this.machines.clear();
  }
}

function tunnelPath(path: PathRequest): TunnelPath {
  return {
    key: path.key,
    link: () =>
      tunnelChannel({
        target:
          path.target.kind === "relay"
            ? { kind: "relay", url: path.target.url, pinnedFingerprint: path.target.hostId }
            : { kind: "local", url: path.target.url },
        ...(path.target.kind === "relay" ? { expectedHostId: path.target.hostId } : {}),
        deviceId: path.deviceId,
        credential: async () => path.token,
        socket: browserDeviceSocket,
        keys: ephemeralRelayKeys,
        schedule,
      }),
  };
}
