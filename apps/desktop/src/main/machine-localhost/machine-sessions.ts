import { session as sessions, type OnBeforeRequestListenerDetails, type Session } from "electron";
import { blocksLoopbackRequest } from "./loopback.ts";
import { machinePartition, machineProxy } from "./machine-partition.ts";
import { MachineProxy } from "./socks-server.ts";
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
  now(): number;
  log(message: string): void;
}

/** The few permissions a device tab's page gets; everything else is refused. */
const permitted = new Set(["clipboard-sanitized-write", "fullscreen"]);
/** Partitions this process sets up at most; each one holds a proxy. */
const machineLimit = 16;

/**
 * Each remote machine's session partition (ADR 0194), made the first time one of its device
 * tabs opens: a SOCKS5 proxy on this computer's loopback that sends the partition's loopback
 * through the machine's tunnel, every other host direct, and a request filter that keeps public
 * pages away from the machine's localhost. The default session and every other partition are
 * untouched.
 */
export class MachineSessions {
  private machines = new Map<string, Promise<MachineSession>>();
  private proxies = new Set<MachineProxy>();
  private options: MachineSessionsOptions;

  constructor(options: MachineSessionsOptions) {
    this.options = options;
  }

  get(machineId: string): Promise<MachineSession> {
    let pending = this.machines.get(machineId);
    if (pending) return pending;
    if (this.machines.size >= machineLimit)
      return Promise.reject(new Error("Too many machines have device tabs open"));
    pending = this.setUp(machineId);
    this.machines.set(machineId, pending);
    pending.catch(() => this.machines.delete(machineId));
    return pending;
  }

  /** Stops every proxy; their connections reset. */
  async close(): Promise<void> {
    this.machines.clear();
    await Promise.all([...this.proxies].map((proxy) => proxy.close()));
    this.proxies.clear();
  }

  private async setUp(machineId: string): Promise<MachineSession> {
    const failures = new TunnelFailures(this.options.now);
    const proxy = await MachineProxy.listen({
      tunnel: () => this.options.tunnel(machineId),
      failures,
      log: this.options.log,
    });
    this.proxies.add(proxy);
    const partition = machinePartition(machineId);
    const session = sessions.fromPartition(partition);
    try {
      await session.setProxy(machineProxy(proxy.port));
      // Connections made before the proxy (none, normally) would bypass it.
      await session.closeAllConnections();
    } catch (error) {
      this.proxies.delete(proxy);
      await proxy.close();
      throw error;
    }
    session.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: blocksLoopbackRequest({
          url: details.url,
          resourceType: details.resourceType,
          topUrl: topUrl(details),
        }),
      }),
    );
    session.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permitted.has(permission)),
    );
    session.setPermissionCheckHandler((_contents, permission) => permitted.has(permission));
    return { machineId, partition, session, failures };
  }
}

/** The request's top-level page: its frame's top, else its tab's page; undefined if gone. */
function topUrl(details: OnBeforeRequestListenerDetails): string | undefined {
  try {
    const top = details.frame?.top?.url;
    if (top) return top;
  } catch {
    /* the frame went away */
  }
  try {
    const contents = details.webContents;
    return contents && !contents.isDestroyed() ? contents.getURL() || undefined : undefined;
  } catch {
    return undefined;
  }
}
