import {
  openPathTunnel,
  type MachineTunnel,
  type TunnelDialer,
  type TunnelPathTarget,
} from "@ace/client/machine-tunnel";
import type { z } from "zod";
import type { MachineTunnelPath } from "../../shared/device-tabs.ts";

/** The path a window's renderer says one machine's connection is on, with its credential. */
export type PathRequest = NonNullable<z.output<typeof MachineTunnelPath>["path"]>;

interface Machine {
  /** Each window's latest path, by its renderer's id; the most recently told is used. */
  leases: Map<number, PathRequest>;
  /** Who the tunnel proves the machine is, and as which device. */
  identity: string;
  /** The target the tunnel dials now; a new object is a path switch. */
  target: TunnelPathTarget | undefined;
  /** The credential the target was made with; another one is a new target. */
  token: string;
  listeners: Set<() => void>;
  tunnel: MachineTunnel | undefined;
}

export interface MachineTunnelsOptions {
  dialer: TunnelDialer;
  schedule(run: () => void, delayMs: number): () => void;
  /** The machine's last lease went: nothing here holds its credential or its tunnel now. */
  idle(machineId: string): void;
}

const identityOf = (path: PathRequest) => JSON.stringify([path.expectedHostId, path.deviceId]);
const latestOf = (machine: Machine) => [...machine.leases.values()].at(-1);

/**
 * Each remote machine's tunnel, opened here in the main process beside its proxy (ADR 0194),
 * with the pinned, ticketed dialer (`openPathTunnel`): a direct path pins the listener's key and
 * sends a one-use ticket, never the token; a relay pins the daemon's Noise key; every welcome
 * must name the machine.
 *
 * A window's renderer holds a lease on a machine by telling it the path its connection is on.
 * The lease (and the credential with it) goes when the renderer says the machine is offline or
 * gone, when its window's last device tab of the machine closes, and when the renderer reloads or
 * goes away. When a machine's last lease goes, its tunnel closes. A new credential for the same
 * path is a new path: new streams open with it, and the old connection drains.
 */
export class MachineTunnels {
  private machines = new Map<string, Machine>();
  private options: MachineTunnelsOptions;
  private generation = 0;

  constructor(options: MachineTunnelsOptions) {
    this.options = options;
  }

  /** Window `sender`'s renderer says the machine's connection is on `path`, or on none. */
  publish(sender: number, machineId: string, path: PathRequest | undefined): void {
    let machine = this.machines.get(machineId);
    if (!path) {
      if (machine?.leases.delete(sender)) this.settle(machineId, machine);
      return;
    }
    if (!machine) {
      machine = {
        leases: new Map(),
        identity: identityOf(path),
        target: undefined,
        token: "",
        listeners: new Set(),
        tunnel: undefined,
      };
      this.machines.set(machineId, machine);
    }
    // The latest teller's path wins: re-inserting keeps the map ordered by when each told.
    machine.leases.delete(sender);
    machine.leases.set(sender, path);
    this.settle(machineId, machine);
  }

  /** Window `sender`'s lease on one machine ends (its last device tab of it closed). */
  release(sender: number, machineId: string): void {
    this.publish(sender, machineId, undefined);
  }

  /** Window `sender`'s renderer reloaded or went away: every lease it held ends. */
  forgetSender(sender: number): void {
    for (const [machineId, machine] of this.machines)
      if (machine.leases.delete(sender)) this.settle(machineId, machine);
  }

  /** Whether any window holds a lease on the machine. */
  holds(machineId: string): boolean {
    return this.machines.has(machineId);
  }

  /** The machine's tunnel, opened on first use; undefined while no window has told a path. */
  tunnel(machineId: string): MachineTunnel | undefined {
    const machine = this.machines.get(machineId);
    const latest = machine && latestOf(machine);
    if (!machine || !latest) return undefined;
    machine.tunnel ??= openPathTunnel({
      machine: {
        expectedHostId: latest.expectedHostId,
        deviceId: latest.deviceId,
        // Read at each dial, so a replaced credential is the one used next.
        token: async () => latestOf(machine)?.token ?? "",
      },
      path: {
        get: () => machine.target,
        subscribe: (changed) => {
          machine.listeners.add(changed);
          return () => machine.listeners.delete(changed);
        },
      },
      dialer: this.options.dialer,
      schedule: this.options.schedule,
    });
    return machine.tunnel;
  }

  close(): void {
    for (const machine of this.machines.values()) machine.tunnel?.close();
    this.machines.clear();
  }

  /** Follows the machine's latest lease, or lets the machine go with its last one. */
  private settle(machineId: string, machine: Machine): void {
    const latest = latestOf(machine);
    if (!latest) {
      machine.tunnel?.close();
      this.machines.delete(machineId);
      this.options.idle(machineId);
      return;
    }
    // Another device id or daemon is another tunnel altogether.
    if (identityOf(latest) !== machine.identity) {
      machine.tunnel?.close();
      machine.tunnel = undefined;
      machine.identity = identityOf(latest);
      machine.target = undefined;
    }
    const target = machine.target;
    if (target && samePath(target, latest) && machine.token === latest.token) return;
    machine.token = latest.token;
    // A new key per credential: the tunnel takes it as a path switch.
    machine.target = targetOf(latest, ++this.generation);
    for (const listener of machine.listeners) listener();
  }
}

const samePath = (target: TunnelPathTarget, path: PathRequest) =>
  target.url === path.target.url &&
  target.key.startsWith(`${path.key}#`) &&
  (target.kind === "direct"
    ? path.target.kind === "direct" && target.fingerprint === path.target.fingerprint
    : path.target.kind === "relay" && target.hostKey === path.target.hostKey);

function targetOf(path: PathRequest, generation: number): TunnelPathTarget {
  const key = `${path.key}#${generation}`;
  return path.target.kind === "direct"
    ? { kind: "direct", key, url: path.target.url, fingerprint: path.target.fingerprint }
    : { kind: "relay", key, url: path.target.url, hostKey: path.target.hostKey };
}
