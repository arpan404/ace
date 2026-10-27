import { Client, type Scheduler, type Storage, type Transport } from "@ace/client";
import { DeviceId, HostId } from "@ace/protocol";
import { PinnedTransportError, TrustMonitor } from "../security/pinned-transport.ts";
import {
  bridgePinnedHttp,
  bridgeSocketTransport,
  ticketFetch,
  type ExpoPinnedBridge,
} from "../security/expo-bridge.ts";
import { isPin } from "../security/trust.ts";
import { loadCredential, type CredentialStore } from "../pairing/credentials.ts";
import { pairedSocketCredential } from "../pairing/tickets.ts";
import { ProductionTransportError, type MachineRuntime } from "./machines-runtime.ts";
import type { MachineEntry } from "@ace/client/machines";

/**
 * Production per-machine runtime wiring.
 *
 * Mirrors the iOS `ClientModel.connect` boundary (`ClientRuntime` over a
 * `ConnectionTarget`): one SDK `Client` per paired entry with its own pinned
 * WSS transport, its own credential closure and its own per-machine `Storage`
 * namespace (outbox plus immutable host binding, one owner per
 * daemon/device). The manager (`machines-runtime.ts`) owns lifecycle:
 * serialized replacement, close-before-remove and per-machine epochs.
 *
 * Fail-closed rules:
 *
 * - Relay targets and malformed pins never reach the network: relay entries
 *   throw `ProductionTransportError` (Android supports direct pairings only,
 *   like iOS `connectionTarget` returning nil for relay entries), and a bad
 *   pin throws `PinnedTransportError` before any socket, fetch or credential
 *   is touched.
 * - Every connection attempt re-reads the device token from the Keystore
 *   store and exchanges it for a fresh single-use ticket over pinned HTTPS.
 *   Tickets are never cached and tokens never leave the credential store.
 * - The `Storage` namespace is derived from the entry's host and device
 *   identity, so two machines never share an outbox. The database tables
 *   must be ensured (via `ensureOutboxTables`) before the first runtime is
 *   built; `storageFor` itself is synchronous because the manager's
 *   `makeRuntime` boundary is.
 */

export interface ProductionEpochs {
  isCurrent(hostId: string, epoch: number): boolean;
  epochOf(hostId: string): number | undefined;
}

export interface ProductionRuntimeDeps {
  readonly bridge: ExpoPinnedBridge;
  readonly credentials: CredentialStore;
  /** Per-machine `Storage` namespace. Must be scoped by `namespaceFor`. */
  readonly storageFor: (entry: MachineEntry) => Storage;
  /** Manager epochs for the stale-callback guard; absent in standalone use. */
  readonly epochs?: ProductionEpochs | undefined;
  readonly scheduler?: Scheduler | undefined;
  readonly id?: (() => string) | undefined;
  readonly random?: (() => number) | undefined;
  readonly now?: (() => number) | undefined;
  readonly socketId?: (() => string) | undefined;
  readonly trustFor?: ((entry: MachineEntry) => TrustMonitor) | undefined;
  /**
   * Test seam for the socket transport. Production always uses the pinned
   * native bridge; tests substitute a loopback transport to exercise the
   * credential, namespace and lifecycle wiring without a device or daemon.
   */
  readonly transportFor?:
    | ((
        entry: MachineEntry,
        context: { trust: TrustMonitor; isCurrent: () => boolean },
      ) => Transport)
    | undefined;
  /** Observes each built client; tests use it to await readiness. */
  readonly observe?: ((entry: MachineEntry, client: Client) => void) | undefined;
}

/**
 * Outbox/database scope for one paired computer, mirroring iOS's per-machine
 * database name. Encoded as the JSON pair also used for the credential key
 * (`machineSecretKey`): raw NUL separators are unsafe here because the
 * namespace travels as a bound SQLite TEXT value, where an embedded NUL
 * truncates the comparison and can alias two machines onto one namespace.
 * The JSON encoding is injective and NUL-free.
 */
export function namespaceFor(entry: { hostId: string; deviceId: string }): string {
  return JSON.stringify([entry.hostId, entry.deviceId]);
}

/** HTTPS origin of the same daemon listener, for the pinned ticket exchange. */
export function httpsOriginForSocketUrl(socketUrl: string): string {
  const url = new URL(socketUrl);
  if (url.protocol !== "wss:") throw new PinnedTransportError("invalid");
  url.protocol = "https:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Fresh single-use ticket credential for one paired entry. Re-reads the
 * Keystore token on every attempt so revocation and re-pairing take effect
 * without restarting the app; a missing or malformed token surfaces as an
 * authentication failure that routes the machine back to pairing.
 */
export function createProductionCredential(
  deps: Pick<ProductionRuntimeDeps, "bridge" | "credentials">,
  entry: MachineEntry,
  trust?: TrustMonitor | undefined,
): () => Promise<{ ticket: string }> {
  if (entry.target.kind !== "direct" || !isPin(entry.target.fingerprint ?? ""))
    throw new PinnedTransportError("invalid");
  const origin = httpsOriginForSocketUrl(entry.target.url);
  const fingerprint = entry.target.fingerprint ?? "";
  const http = bridgePinnedHttp(deps.bridge, { origin, fingerprint });
  return pairedSocketCredential({
    socketUrl: entry.target.url,
    token: () => loadCredential(deps.credentials, entry),
    fetch: ticketFetch(http, { trust }),
  });
}

export interface ProductionMachineRuntime extends MachineRuntime {
  /** Binds the manager epoch captured after this runtime attached. */
  bindEpoch(epoch: number): void;
}

export function createProductionMakeRuntime(
  deps: ProductionRuntimeDeps,
): (entry: MachineEntry) => ProductionMachineRuntime {
  let ids = 0;
  const scheduler: Scheduler = deps.scheduler ?? {
    set(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const id = deps.id ?? (() => `client-${Date.now()}-${(ids += 1)}`);
  const random = deps.random ?? (() => Math.random());
  return (entry) => {
    if (entry.target.kind !== "direct") throw new ProductionTransportError();
    const fingerprint = entry.target.kind === "direct" ? (entry.target.fingerprint ?? "") : "";
    if (!isPin(fingerprint)) throw new PinnedTransportError("invalid");
    const trust = deps.trustFor?.(entry) ?? new TrustMonitor();
    let epoch: number | undefined;
    const isCurrent = () => {
      if (epoch === undefined || deps.epochs === undefined) return true;
      return deps.epochs.isCurrent(entry.hostId, epoch);
    };
    const transport =
      deps.transportFor?.(entry, { trust, isCurrent }) ??
      bridgeSocketTransport(deps.bridge, {
        url: entry.target.url,
        fingerprint,
        id: deps.socketId ?? (() => id()),
        trust,
        isCurrent,
      });
    const client = new Client({
      deviceId: DeviceId.parse(entry.deviceId),
      expectedHostId: HostId.parse(entry.hostId),
      transport: () => transport,
      credential: createProductionCredential(deps, entry, trust),
      storage: deps.storageFor(entry),
      scheduler,
      id,
      random,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      // The production tail is the shared default (200 items); the 2,200-item
      // spike cap must never leak into this configuration.
      limits: { items: 200 },
    });
    deps.observe?.(entry, client);
    return {
      bindEpoch(next: number) {
        epoch = next;
      },
      async start() {
        await client.start();
      },
      async close() {
        await client.close();
      },
      networkOnline(online: boolean) {
        client.networkOnline(online);
      },
      reconnectNow() {
        client.reconnectNow();
      },
      wake() {
        client.wake();
      },
    };
  };
}
