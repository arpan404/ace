import {
  Client,
  type ClientApi,
  type ClientError,
  type ConnectionState,
  type Scheduler,
  type Selection,
  type Storage,
  type Transport,
} from "@ace/client";
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
  /**
   * Per-call admission guard. Production startup supplies a closure that
   * throws when the entry's recorded grant is view-only; the guarded
   * admission below runs it on every mutating call, so even a leaked
   * admission object fails closed after revocation.
   */
  readonly assertAdmission?: ((entry: MachineEntry) => void) | undefined;
  /**
   * Observes connection readiness only. Receives a read-only signals view
   * (`connectionState`/`error`); the SDK `Client` itself never escapes, so
   * an observer cannot cache a mutation handle around the grant.
   */
  readonly observe?: ((entry: MachineEntry, signals: ProductionRuntimeSignals) => void) | undefined;
}

/**
 * Read-only connection signals for tests. Deliberately omits every command
 * admission method: polling readiness must never hand out a mutation handle.
 */
export interface ProductionRuntimeSignals {
  connectionState(): Selection<ConnectionState>;
  readonly error: ClientError | undefined;
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

export interface ProductionMutations extends Pick<
  ClientApi,
  "enqueue" | "command" | "submitNew" | "intent"
> {}

export interface ProductionMachineRuntime extends MachineRuntime {
  /** Binds the manager epoch captured after this runtime attached. */
  bindEpoch(epoch: number): void;
}

/**
 * Per-factory admission registry. The callable builds lifecycle-only
 * runtimes for the manager (`manager.client` never sees command admission
 * at runtime, not just in the types); `admissionFor` resolves the guarded
 * admission for one connected host, or `undefined` once its runtime closed.
 * Every admission object is pinned to the exact runtime record observed at
 * lookup: every method re-runs `assertAdmission` against the current entry
 * and re-checks the binding identity plus the epoch guard, so a cached
 * admission fails closed after revocation, same-host replacement or re-pair,
 * disconnect or removal instead of forwarding to the new owner. `intent`
 * checks binding liveness only.
 */
export interface ProductionMakeRuntime {
  (entry: MachineEntry): ProductionMachineRuntime;
  admissionFor(hostId: string): ProductionMutations | undefined;
}

function notConnected(): Error {
  return new Error("This machine is not connected.");
}

export function createProductionMakeRuntime(deps: ProductionRuntimeDeps): ProductionMakeRuntime {
  let ids = 0;
  const scheduler: Scheduler = deps.scheduler ?? {
    set(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const id = deps.id ?? (() => `client-${Date.now()}-${(ids += 1)}`);
  const random = deps.random ?? (() => Math.random());
  const live = new Map<string, { client: Client; entry: MachineEntry; isCurrent: () => boolean }>();
  const resolveCurrent = (hostId: string): { client: Client; entry: MachineEntry } => {
    const current = live.get(hostId);
    if (current === undefined || !current.isCurrent()) {
      if (current !== undefined) live.delete(hostId);
      throw notConnected();
    }
    return current;
  };
  const makeRuntime = ((entry: MachineEntry): ProductionMachineRuntime => {
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
    // Read-only readiness view: no mutation handle escapes to observers.
    deps.observe?.(entry, {
      connectionState: client.connectionState.bind(client),
      get error() {
        return client.error;
      },
    });
    live.set(entry.hostId, { client, entry, isCurrent });
    return {
      bindEpoch(next: number) {
        epoch = next;
      },
      async start() {
        await client.start();
      },
      async close() {
        // A failed close keeps the single owner attached (the manager retries
        // it): only a successful close detaches the guarded admission below.
        await client.close();
        if (live.get(entry.hostId)?.client === client) live.delete(entry.hostId);
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
  }) as ProductionMakeRuntime;
  makeRuntime.admissionFor = (hostId: string): ProductionMutations | undefined => {
    const bound = live.get(hostId);
    if (bound === undefined || !bound.isCurrent()) {
      if (bound !== undefined) live.delete(hostId);
      return undefined;
    }
    const boundRecord = bound;
    const boundClient = bound.client;
    // Pinned to the exact runtime record observed here. A same-host
    // replacement or re-pair mints a new record, so a cached admission must
    // fail instead of forwarding to the new owner; the grant below is always
    // read from the current record, never the stale capture.
    const checkBound = (): { client: Client; entry: MachineEntry } => {
      const current = resolveCurrent(hostId);
      if (current !== boundRecord || current.client !== boundClient) {
        throw notConnected();
      }
      return current;
    };
    // Fresh guarded admission per lookup, and every method re-checks: a
    // previously returned admission object still fails closed after
    // revocation (assertAdmission on the current entry), replacement or
    // re-pair (binding identity above), or close/removal (registry delete in
    // `close`).
    return {
      enqueue: async (payload, commandId) => {
        const current = checkBound();
        deps.assertAdmission?.(current.entry);
        if (live.get(hostId) !== boundRecord) throw notConnected();
        return current.client.enqueue(payload, commandId);
      },
      command: async (payload, options, commandId) => {
        const current = checkBound();
        deps.assertAdmission?.(current.entry);
        if (live.get(hostId) !== boundRecord) throw notConnected();
        return current.client.command(payload, options, commandId);
      },
      submitNew: async (payload, record, options) => {
        const current = checkBound();
        deps.assertAdmission?.(current.entry);
        if (live.get(hostId) !== boundRecord) throw notConnected();
        return current.client.submitNew(payload, record, options);
      },
      intent: (commandId) => {
        const current = checkBound();
        return current.client.intent(commandId);
      },
    };
  };
  return makeRuntime;
}
