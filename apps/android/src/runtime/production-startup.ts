import { ClientError } from "@ace/client";
import type { Intent, RequestOptions, Selection, Storage } from "@ace/client";
import type { CommandPayload, CommandResult } from "@ace/protocol";
import type { SQLiteDatabase } from "expo-sqlite";
import { z } from "zod";
import { TrustMonitor } from "../security/pinned-transport.ts";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { deleteOutboxNamespace, ensureOutboxTables, sqliteNamespace } from "../storage.ts";
import { createPairingMachines, type PairingMachines } from "../pairing/machines.ts";
import type { ConfirmedPairing } from "../pairing/pairing-flow.ts";
import { createPinnedPairingTransport, type IdentityReader } from "../pairing/pinned-pairing.ts";
import type { CredentialStore } from "../pairing/credentials.ts";
import {
  createMachinesRuntime,
  type MachineRuntime,
  type MachinesRuntime,
} from "./machines-runtime.ts";
import {
  createProductionMakeRuntime,
  namespaceFor,
  type ProductionEpochs,
  type ProductionMachineRuntime,
  type ProductionMakeRuntime,
  type ProductionMutations,
  type ProductionRuntimeDeps,
} from "./production-runtime.ts";
import type { MachineEntry } from "@ace/client/machines";

/**
 * Production startup: directory, per-machine runtimes, grants and pairing routing.
 *
 * Mirrors the iOS `MachinesModel` lifecycle without copying it: the directory
 * and credentials stay in the shared `MachineDirectory` plus the Keystore
 * store, each paired machine connects on its own runtime (pinned WSS, fresh
 * ticket per attempt, scoped outbox namespace), and removal stops that
 * machine's runtime before deleting its credential and local rows. The other
 * machines keep running throughout.
 *
 * What this module does not do (later milestones own it): render pairing or
 * inbox UI, capture QR codes, app lock, notification binding, pending-read
 * bounds and cross-machine inbox merging. The production entry point stays an
 * unpaired shell until that UI wiring lands.
 */

/**
 * Scopes the host granted this phone. There is no default: a device with no
 * recorded row cannot operate. This is deliberately stricter than the iOS
 * `MachinesModel.canOperate` fallback (`?? ["operate"]`): an unknown or
 * dropped grant means this boundary never saw the host choose operate, so a
 * known host with a missing row, and every host when the persisted file is
 * malformed, stays view-only until a pairing records its scopes.
 */
const GrantsFile = z.record(z.string(), z.array(z.string().max(256)).max(64));

export interface GrantsPersistence {
  load(): Promise<Record<string, string[]> | null>;
  save(grants: Record<string, string[]>): Promise<void>;
}

export interface GrantStore {
  load(): Promise<void>;
  scopesFor(deviceId: string): string[];
  canOperateFor(deviceId: string): boolean;
  setScopes(deviceId: string, scopes: readonly string[]): Promise<void>;
  remove(deviceId: string): Promise<void>;
}

export function createGrantStore(persistence?: GrantsPersistence | undefined): GrantStore {
  let scopes = new Map<string, string[]>();
  async function persist(): Promise<void> {
    if (persistence === undefined) return;
    const snapshot: Record<string, string[]> = {};
    for (const [deviceId, entries] of scopes) snapshot[deviceId] = [...entries];
    await persistence.save(snapshot);
  }
  return {
    async load() {
      const saved = (await persistence?.load()) ?? null;
      const parsed = GrantsFile.safeParse(saved ?? {});
      // A malformed file parses to nothing: every device reads as unknown
      // (view-only) rather than inheriting an operate default, and the next
      // `setScopes` persists only rows written through this boundary.
      scopes = new Map(
        parsed.success ? Object.entries(parsed.data).map(([key, value]) => [key, [...value]]) : [],
      );
    },
    scopesFor(deviceId) {
      return [...(scopes.get(deviceId) ?? [])];
    },
    canOperateFor(deviceId) {
      const granted = scopes.get(deviceId);
      if (granted === undefined) return false;
      return granted.includes("operate") || granted.includes("admin");
    },
    async setScopes(deviceId, next) {
      scopes.set(deviceId, [...next]);
      await persist();
    },
    async remove(deviceId) {
      scopes.delete(deviceId);
      await persist();
    },
  };
}

/**
 * Local refusal for a view-only grant. Deliberately not a `ClientError`: it is
 * an admission-time guard, not a connection failure, so it must never route
 * the machine back to pairing the way `auth` failures do.
 */
export class ViewOnlyError extends Error {
  constructor() {
    super("View only. Pair this phone with View and act to make changes.");
    this.name = "ViewOnlyError";
  }
}

/** Throw when a view-only pairing is asked to mutate. Read-only rows stay readable. */
export function assertCanOperate(grants: GrantStore, entry: { deviceId: string }): void {
  if (!grants.canOperateFor(entry.deviceId)) throw new ViewOnlyError();
}

function mutationNotConnected(): Error {
  return new Error("This machine is not connected.");
}

function bindingFingerprint(candidate: MachineEntry | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  return candidate.target.kind === "direct" ? (candidate.target.fingerprint ?? "") : undefined;
}

/** expo-sqlite metadata backing for the grant store, beside the outbox tables. */
export function sqliteGrantsPersistence(db: SQLiteDatabase): GrantsPersistence {
  const namespace = "ace-grants";
  return {
    async load() {
      const row: unknown = await db.getFirstAsync(
        "SELECT value FROM metadata WHERE namespace=? AND key=?",
        namespace,
        "grants",
      );
      if (row === null) return null;
      const parsed = GrantsFile.safeParse(
        JSON.parse(z.object({ value: z.string() }).parse(row).value) as unknown,
      );
      return parsed.success ? parsed.data : null;
    },
    async save(grants) {
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.runAsync(
          "INSERT OR REPLACE INTO metadata VALUES (?,?,?)",
          namespace,
          "grants",
          JSON.stringify(grants),
        );
      });
    },
  };
}

/** The database surface production startup needs; tests inject memory fakes. */
export interface StartupDatabase {
  ensureOutboxTables(): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
  storageFor(namespace: string): Storage;
  grants: GrantsPersistence;
}

export function sqliteStartupDatabase(db: SQLiteDatabase): StartupDatabase {
  return {
    ensureOutboxTables: () => ensureOutboxTables(db),
    deleteNamespace: (namespace) => deleteOutboxNamespace(db, namespace),
    storageFor: (namespace) => sqliteNamespace(db, namespace),
    grants: sqliteGrantsPersistence(db),
  };
}

export type StartupRoute =
  | { route: "paired" }
  | {
      route: "pairing";
      reason: "missing" | "revoked" | "pin" | "unsupported";
      message: string;
    };

/**
 * Where one machine's UI goes. Pure decision over the directory entry, the
 * manager's recorded failure and the socket's trust report:
 *
 * - no entry (removed elsewhere) or missing credential → pair again;
 * - pin refusal or host-identity mismatch → pair again (wrong computer);
 * - revoked token (`auth`) → pair again;
 * - anything else (offline, storage, starting) → stay, the SDK keeps retrying.
 */
export function startupRoute(input: {
  entry?: MachineEntry | undefined;
  failure?: unknown;
  trustFailure?: "pin" | undefined;
}): StartupRoute {
  if (input.entry === undefined)
    return { route: "pairing", reason: "missing", message: "This machine is no longer paired." };
  if (input.entry.target.kind !== "direct")
    return {
      route: "pairing",
      reason: "unsupported",
      message: "This machine needs pairing again.",
    };
  if (input.trustFailure === "pin")
    return {
      route: "pairing",
      reason: "pin",
      message: "This computer's identity doesn't match the pairing link. Nothing was sent.",
    };
  const failure = input.failure;
  if (failure instanceof ClientError && failure.code === "auth")
    return {
      route: "pairing",
      reason: "revoked",
      message: "This machine needs pairing again.",
    };
  if (failure instanceof ClientError && failure.code === "identity")
    return {
      route: "pairing",
      reason: "pin",
      message: "This computer's identity doesn't match the pairing link. Nothing was sent.",
    };
  if (failure instanceof Error && /needs pairing again/i.test(failure.message))
    return {
      route: "pairing",
      reason: "revoked",
      message: "This machine needs pairing again.",
    };
  return { route: "paired" };
}

export interface ProductionStartupDeps {
  readonly bridge: ExpoPinnedBridge;
  readonly credentials: CredentialStore;
  /** Non-secret directory metadata; device tokens live only in `credentials`. */
  readonly directoryStorage: Storage;
  readonly database: StartupDatabase;
  /**
   * Test seam for the pairing identity read. Production always reads
   * `host.identity` over a fresh pinned connection; tests substitute a stub
   * so no socket or daemon is needed.
   */
  readonly identityReader?: IdentityReader | undefined;
  /**
   * Test seam for the socket transport. Production always uses the pinned
   * native bridge; tests substitute a loopback transport to exercise real
   * command admission against a fake daemon with no device.
   */
  readonly transportFor?: ProductionRuntimeDeps["transportFor"] | undefined;
  /**
   * Deterministic clocks for tests (a never-firing scheduler keeps unstarted
   * runtimes from retrying in the background). Production omits this.
   */
  readonly clocks?:
    | {
        scheduler?: import("@ace/client").Scheduler | undefined;
        id?: (() => string) | undefined;
        random?: (() => number) | undefined;
        now?: (() => number) | undefined;
        socketId?: (() => string) | undefined;
      }
    | undefined;
}

/**
 * A short-lived admission gate for one machine's mutations. Unlike the raw
 * `MachineRuntime` behind `manager.client` (lifecycle only, never command
 * admission), a gate never hands out a cachable handle: every method
 * re-resolves the grant and the live runtime at call time, so revocation,
 * disconnect or removal takes effect even on a gate the caller kept. The
 * underlying SDK `Client` is reachable only through the gate's per-call
 * resolver; `manager.client` exposes no `enqueue`/`command`/`submitNew`, so
 * mutations cannot bypass the grant. `start`/`close` are absent on purpose:
 * lifecycle stays with the manager and is not a mutation.
 *
 * Mirrors the iOS `ClientModel` per-operation guard (`guard canOperate` on
 * every command submission): `enqueue`, `command` and `submitNew` throw
 * `ViewOnlyError` for view-only grants (or unknown hosts, or missing grant
 * rows) before touching the outbox or the network, so a refused call admits
 * nothing and a `submitNew` refusal never runs its `record` callback. `intent`
 * is the read-only receipt view and needs no grant, only a live runtime.
 */
export interface MutationGate {
  readonly hostId: string;
  /** Re-resolve admission and liveness now; throws `ViewOnlyError` or `not connected`. */
  check(): void;
  reconnectNow(): void;
  wake(): void;
  networkOnline(online: boolean): void;
  /** Durably admit one command; throws `ViewOnlyError` or `not connected`. */
  enqueue(payload: CommandPayload, id?: string): Promise<string>;
  /** Admit one command and wait for its receipt; throws `ViewOnlyError` or `not connected`. */
  command(payload: CommandPayload, options?: RequestOptions, id?: string): Promise<CommandResult>;
  /**
   * Admit one command under a caller-recorded id. The grant and liveness are
   * checked before `record` runs, so a refused call records nothing.
   */
  submitNew(
    payload: CommandPayload,
    record: (id: string) => void | Promise<void>,
    options?: RequestOptions,
  ): Promise<CommandResult>;
  /** The durable receipt for one admitted command; read-only, needs only liveness. */
  intent(id: string): Selection<Intent | undefined>;
}
export interface ProductionStartup {
  readonly manager: MachinesRuntime;
  readonly directory: PairingMachines;
  readonly grants: GrantStore;
  /** The socket trust report for one machine; drives pin-mismatch routing. */
  trustOf(entry: MachineEntry): TrustMonitor;
  load(): Promise<readonly MachineEntry[]>;
  /**
   * Whether this phone may send commands to one machine. Known entries defer
   * to the recorded grant; unknown hosts, and known hosts with no recorded
   * grant row, fail closed (view-only). This is stricter than the iOS
   * `MachinesModel.canOperate` unknown-device default; see the grants note
   * above. Screens must resolve this (or call `assertCanOperateFor`) before
   * admitting inbox, approval, question, composer or screen actions; the
   * daemon re-enforces the grant.
   */
  canOperate(hostId: string): boolean;
  /**
   * Throw `ViewOnlyError` when `canOperate(hostId)` is false. Call before
   * every mutation bound to a machine until UI wiring lands; read-only rows
   * stay readable.
   */
  assertCanOperateFor(hostId: string): void;
  /**
   * A short-lived mutation gate bound to one machine: the single admission
   * point for every future inbox, approval, question, composer or screen
   * mutation. Each call returns a fresh gate (never the shared live
   * runtime), and every gate method re-resolves the grant and the live
   * runtime at call time: a cached gate stops working when the grant is
   * revoked, the runtime disconnects, the machine is removed, or the binding
   * is replaced or re-paired (epoch plus device and pin pin the gate to the
   * exact owner observed at creation, so it never forwards to the new owner). `enqueue`,
   * `command` and `submitNew` throw `ViewOnlyError` when the recorded grant
   * is view-only (or the host is unknown, or its grant row is missing) before
   * touching the outbox or the network, and throw when the machine has no
   * live runtime or the binding changed since the gate was issued, so a view-only phone cannot reach a mutating path through
   * this boundary and a cached raw handle can never outlive revocation.
   * `intent` is the read-only receipt view and needs only liveness.
   * Read-only receipts stay readable through the gate's `intent` and `route`;
   * `manager.client` exposes lifecycle only (no reads and no `enqueue`/
   * `command`/`submitNew`), so mutating call sites must go through the gate and must
   * never cache a gate past one flow. `start`/`close` stay with the manager:
   * lifecycle is not a mutation.
   */
  runtimeForMutation(hostId: string): MutationGate;
  route(hostId: string): StartupRoute;
  pair(
    confirmed: ConfirmedPairing,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<MachineEntry>;
  remove(hostId: string): Promise<void>;
  setOnline(online: boolean, interfaceChanged?: boolean): void;
  wake(): void;
  disconnectAll(): Promise<void>;
}

export function createProductionStartup(deps: ProductionStartupDeps): ProductionStartup {
  const grants = createGrantStore(deps.database.grants);
  const directory = createPairingMachines({
    storage: deps.directoryStorage,
    credentials: deps.credentials,
  });
  const trusts = new Map<
    string,
    { monitor: TrustMonitor; fingerprint: string; deviceId: string }
  >();
  /**
   * The socket trust report for one machine, scoped by machine identity
   * (host plus confirmed pin plus device). A pin failure belongs to the exact
   * binding that produced it: re-pairing with a new fingerprint or device
   * mints a fresh monitor instead of inheriting the old failure. Neither a
   * ticket success nor a socket `open` clears it (ADR 0097 `*.ts.net`
   * fallback: success cannot prove the pin matched), so a mismatch sticks
   * until the binding changes. Removal and directory prune drop the monitor,
   * so a later pairing under the same host id starts clean.
   */
  const trustOf = (entry: MachineEntry): TrustMonitor => {
    const fingerprint = entry.target.kind === "direct" ? (entry.target.fingerprint ?? "") : "";
    const seen = trusts.get(entry.hostId);
    if (
      seen !== undefined &&
      seen.fingerprint === fingerprint &&
      seen.deviceId === entry.deviceId
    ) {
      return seen.monitor;
    }
    const monitor = new TrustMonitor();
    trusts.set(entry.hostId, { monitor, fingerprint, deviceId: entry.deviceId });
    return monitor;
  };
  let manager: MachinesRuntime | undefined;
  const epochs: ProductionEpochs = {
    isCurrent: (hostId, epoch) => manager?.isCurrent(hostId, epoch) ?? true,
    epochOf: (hostId) => manager?.epochOf(hostId),
  };
  const makeRuntime: ProductionMakeRuntime = createProductionMakeRuntime({
    bridge: deps.bridge,
    credentials: deps.credentials,
    storageFor: (entry) => deps.database.storageFor(namespaceFor(entry)),
    epochs,
    trustFor: trustOf,
    // Grant re-check inside the admission itself: even a leaked admission
    // object throws `ViewOnlyError` after revocation instead of admitting.
    assertAdmission: (candidate) => {
      if (!grants.canOperateFor(candidate.deviceId)) throw new ViewOnlyError();
    },
    ...(deps.transportFor === undefined ? {} : { transportFor: deps.transportFor }),
    ...(deps.clocks?.scheduler === undefined ? {} : { scheduler: deps.clocks.scheduler }),
    ...(deps.clocks?.id === undefined ? {} : { id: deps.clocks.id }),
    ...(deps.clocks?.random === undefined ? {} : { random: deps.clocks.random }),
    ...(deps.clocks?.now === undefined ? {} : { now: deps.clocks.now }),
    ...(deps.clocks?.socketId === undefined ? {} : { socketId: deps.clocks.socketId }),
  });
  manager = createMachinesRuntime({
    directory: {
      load: () => directory.load(),
      remove: (hostId) => directory.remove(hostId),
    },
    makeRuntime,
    beforeConnect: async (entry, runtime) => {
      // The session is already attached, so this is the live epoch. Socket
      // events capture it; a replaced runtime's late frames can no longer
      // touch the new owner.
      const epoch = manager?.epochOf(entry.hostId);
      if (epoch !== undefined) (runtime as ProductionMachineRuntime).bindEpoch?.(epoch);
    },
  });
  const canOperate = (hostId: string): boolean => {
    const entry = manager.entry(hostId);
    if (entry === undefined) return false;
    return grants.canOperateFor(entry.deviceId);
  };
  const assertCanOperateFor = (hostId: string): void => {
    if (!canOperate(hostId)) throw new ViewOnlyError();
  };
  const runtimeForMutation = (hostId: string): MutationGate => {
    // Pin to the exact binding observed here (manager epoch plus device and
    // pin). A same-host replacement or re-pair bumps the epoch and swaps the
    // binding, so a cached gate must fail instead of admitting through the
    // new owner; removal and disconnect already fail in the resolvers below,
    // before this check.
    const boundEpoch = manager.epochOf(hostId);
    const boundDevice = manager.entry(hostId)?.deviceId;
    const boundFingerprint = bindingFingerprint(manager.entry(hostId));
    const assertGateBinding = (): void => {
      if (boundEpoch === undefined) throw mutationNotConnected();
      if (manager.epochOf(hostId) !== boundEpoch) throw mutationNotConnected();
      const current = manager.entry(hostId);
      if (current?.deviceId !== boundDevice) throw mutationNotConnected();
      if (bindingFingerprint(current) !== boundFingerprint) throw mutationNotConnected();
    };
    const resolveMutations = (): ProductionMutations => {
      assertCanOperateFor(hostId);
      if (manager.client(hostId) === undefined) throw mutationNotConnected();
      assertGateBinding();
      const admission = makeRuntime.admissionFor(hostId);
      if (admission === undefined) throw mutationNotConnected();
      return admission;
    };
    const resolveForRead = (): ProductionMutations => {
      if (manager.client(hostId) === undefined) throw mutationNotConnected();
      assertGateBinding();
      const admission = makeRuntime.admissionFor(hostId);
      if (admission === undefined) throw mutationNotConnected();
      return admission;
    };
    const resolve = (): MachineRuntime => {
      assertCanOperateFor(hostId);
      const runtime = manager.client(hostId);
      if (runtime === undefined) throw mutationNotConnected();
      assertGateBinding();
      return runtime;
    };
    // Fresh gate per call, no shared handle: every method re-resolves, so a
    // gate cached past revocation, disconnect, removal or replacement fails
    // at use. The raw SDK client never escapes: only per-call bound methods do.
    resolve();
    const gate: MutationGate = {
      hostId,
      check: () => {
        resolve();
      },
      reconnectNow: () => {
        resolve().reconnectNow();
      },
      wake: () => {
        resolve().wake?.();
      },
      networkOnline: (online: boolean) => {
        resolve().networkOnline(online);
      },
      enqueue: async (payload, id) => resolveMutations().enqueue(payload, id),
      command: async (payload, options, id) => resolveMutations().command(payload, options, id),
      submitNew: async (payload, record, options) =>
        resolveMutations().submitNew(payload, record, options),
      intent: (id) => resolveForRead().intent(id),
    };
    return gate;
  };
  const startup: ProductionStartup = {
    manager,
    directory,
    grants,
    trustOf,
    canOperate,
    assertCanOperateFor,
    runtimeForMutation,
    async load() {
      await deps.database.ensureOutboxTables();
      await grants.load();
      const entries = await manager.load();
      // Drop trust reports for machines the directory no longer lists, so a
      // stale pin failure can never outlive its machine or leak into a later
      // pairing under the same host id.
      const live = new Set<string>(entries.map((entry) => entry.hostId));
      for (const hostId of trusts.keys()) {
        if (!live.has(hostId)) trusts.delete(hostId);
      }
      return entries;
    },
    route(hostId) {
      const entry = manager.entry(hostId);
      return startupRoute({
        entry,
        failure: manager.failure(hostId),
        trustFailure: entry === undefined ? undefined : trusts.get(hostId)?.monitor.failure,
      });
    },
    async pair(confirmed, deviceName, signal) {
      const transport = createPinnedPairingTransport({ bridge: deps.bridge }, deps.identityReader);
      const entry = await directory.pair(confirmed, deviceName, transport, signal);
      // A successful pairing stores a new binding (host plus pin plus
      // device), so any failure the previous binding recorded is stale: drop
      // it before the fresh runtime (via `trustOf`) mints a clean monitor. A
      // genuine mismatch on the new binding re-reports on first contact.
      trusts.delete(entry.hostId);
      await grants.setScopes(entry.deviceId, [...confirmed.link.scopes]);
      await manager.connectEntry(entry);
      return entry;
    },
    async remove(hostId) {
      const known = manager.entry(hostId);
      await manager.remove(hostId);
      // The trust report belongs to the removed binding: drop it with the
      // runtime so re-pairing the same host id starts clean.
      trusts.delete(hostId);
      // The credential is already gone (authority-first removal); the outbox
      // rows and grant are inert without it. Best effort: a storage failure
      // here must not fail a removal that already succeeded.
      if (known !== undefined) {
        try {
          await deps.database.deleteNamespace(namespaceFor(known));
        } catch {
          // Orphaned rows belong to a device id with no credential and are
          // never read again; a failed delete stays local to this phone.
        }
        try {
          await grants.remove(known.deviceId);
        } catch {
          // The grant refetches as the default on next load; dropping it is
          // a display concern, not a connection one.
        }
      }
    },
    setOnline(online, interfaceChanged = false) {
      manager.setOnline(online, interfaceChanged);
    },
    wake() {
      manager.wake();
    },
    async disconnectAll() {
      await manager.disconnectAll();
    },
  };
  return startup;
}

/** Re-export for call sites that only reach the startup boundary. */
export type { MachineRuntime, MachinesRuntime };
