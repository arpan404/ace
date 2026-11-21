import { session as sessions, type Session, type WebContents } from "electron";
import { blocksLoopbackRequest } from "./loopback.ts";
import { machinePartition, machineProxy } from "./machine-partition.ts";
import { MachineProxy } from "./machine-proxy.ts";
import { proxyUser } from "./proxy-request.ts";
import type { MachineTunnel } from "./tunnel-contract.ts";
import { TunnelFailures } from "./tunnel-failure.ts";

/** One remote machine's partition on this computer, set up for its device tabs. */
export interface MachineSession {
  machineId: string;
  partition: string;
  session: Session;
  failures: TunnelFailures;
}

export interface MachineSessionsOptions {
  /** The machine's tunnel now, opened in this process; undefined while it can't be reached. */
  tunnel(machineId: string): MachineTunnel | undefined;
  /** A fresh, unguessable secret for each proxy started. */
  secret(): string;
  now(): number;
  log(message: string): void;
}

/** What Electron's `login` event says asked for credentials. */
export interface LoginAsk {
  isProxy: boolean;
  host: string;
  port: number;
}

interface Held {
  machine: MachineSession;
  proxy: MachineProxy;
  secret: string;
}

/** The few permissions a device tab's page gets; everything else is refused. */
const permitted = new Set(["clipboard-sanitized-write", "fullscreen"]);
/** Partitions this process sets up at most; each one holds a proxy. */
const machineLimit = 16;

/**
 * Each remote machine's session partition (ADR 0194), set up when one of its device tabs opens
 * and let go when the last one closes and no window leases its tunnel: an HTTP proxy on this
 * computer's loopback that sends the partition's loopback through the machine's tunnel, every
 * other host direct, and a request filter that keeps public pages away from the machine's
 * localhost. The proxy demands a secret of this run, which only this partition is given
 * (`proxyLogin`). The default session and every other partition are untouched.
 */
export class MachineSessions {
  private machines = new Map<string, { epoch: number; held: Promise<Held> }>();
  private byPort = new Map<number, Held>();
  private epoch = 0;
  private options: MachineSessionsOptions;

  constructor(options: MachineSessionsOptions) {
    this.options = options;
  }

  async get(machineId: string): Promise<MachineSession> {
    let entry = this.machines.get(machineId);
    if (!entry) {
      if (this.machines.size >= machineLimit)
        throw new Error("Too many machines have device tabs open");
      const epoch = ++this.epoch;
      const held = this.setUp(machineId, epoch);
      const created = { epoch, held };
      entry = created;
      this.machines.set(machineId, created);
      held.catch(() => {
        if (this.machines.get(machineId) === created) this.machines.delete(machineId);
      });
    }
    return (await entry.held).machine;
  }

  /**
   * The credentials for Electron's `login` when one of these proxies asks, and the page asking
   * (when there is one) is in that proxy's own partition; undefined for anything else.
   */
  proxyLogin(
    ask: LoginAsk,
    contents?: WebContents,
  ): { username: string; password: string } | undefined {
    if (!ask.isProxy || ask.host !== "127.0.0.1") return undefined;
    const held = this.byPort.get(ask.port);
    if (!held) return undefined;
    if (contents && !contents.isDestroyed() && contents.session !== held.machine.session)
      return undefined;
    return { username: proxyUser, password: held.secret };
  }

  /** The machine has no device tab and no tunnel lease: its proxy stops. */
  async release(machineId: string): Promise<void> {
    const entry = this.machines.get(machineId);
    if (!entry) return;
    this.machines.delete(machineId);
    const held = await entry.held.catch(() => undefined);
    if (held) await this.stop(held);
  }

  /** Stops every proxy; their connections reset. */
  async close(): Promise<void> {
    const all = [...this.machines.values()];
    this.machines.clear();
    await Promise.all(
      all.map(async (entry) => {
        const held = await entry.held.catch(() => undefined);
        if (held) await this.stop(held);
      }),
    );
  }

  private async stop(held: Held): Promise<void> {
    if (this.byPort.get(held.proxy.port) === held) this.byPort.delete(held.proxy.port);
    await held.proxy.close();
  }

  /** Whether `epoch` is still the machine's setup: a release since makes it stale. */
  private current(machineId: string, epoch: number): boolean {
    return this.machines.get(machineId)?.epoch === epoch;
  }

  private async setUp(machineId: string, epoch: number): Promise<Held> {
    const failures = new TunnelFailures(this.options.now);
    const secret = this.options.secret();
    const proxy = await MachineProxy.listen({
      tunnel: () => this.options.tunnel(machineId),
      failures,
      log: this.options.log,
      secret,
    });
    const partition = machinePartition(machineId);
    const session = sessions.fromPartition(partition);
    const held: Held = { machine: { machineId, partition, session, failures }, proxy, secret };
    try {
      // Released while this was starting: a later setup owns the partition's proxy now.
      if (!this.current(machineId, epoch)) throw new Error("The machine's tabs closed");
      this.byPort.set(proxy.port, held);
      await session.setProxy(machineProxy(proxy.port));
      // Connections made before the proxy (none, normally) would bypass it.
      await session.closeAllConnections();
      if (!this.current(machineId, epoch)) throw new Error("The machine's tabs closed");
    } catch (error) {
      await this.stop(held);
      throw error;
    }
    // Asked again for every redirect, with the method that hop sends.
    session.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: blocksLoopbackRequest({
          url: details.url,
          resourceType: details.resourceType,
          method: details.method,
          initiator: details.initiatorOrigin,
        }),
      }),
    );
    session.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permitted.has(permission)),
    );
    session.setPermissionCheckHandler((_contents, permission) => permitted.has(permission));
    return held;
  }
}
