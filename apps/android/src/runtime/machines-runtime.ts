import type { MachineEntry, MachineTarget } from "@ace/client/machines";

/**
 * One paired computer's live runtime, owned by the multi-machine manager.
 *
 * This is the Android equivalent of the iOS `ClientSession` boundary
 * (`apps/ios/Sources/Models/MachinesModel.swift` with `ClientModel`): the
 * manager starts one runtime per paired machine, stops only that machine's
 * runtime on removal, and never lets one machine's failure touch another.
 *
 * The SDK `Client` satisfies this interface. Tests substitute fakes at the
 * `makeRuntime` boundary, so no device, socket or daemon is needed here.
 */
export interface MachineRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
  networkOnline(online: boolean): void;
  reconnectNow(): void;
  wake?(): void;
}

/**
 * The directory surface the runtime manager coordinates with. It is
 * structurally satisfied by `createPairingMachines`
 * (`apps/android/src/pairing/machines.ts`), which keeps owning
 * duplicate-pairing rejection, serialized metadata writes and
 * authority-first credential removal.
 */
export interface MachineRuntimeDirectory {
  load(): Promise<readonly MachineEntry[]>;
  remove(hostId: string): Promise<void>;
}

/** Production has no runtime wiring yet, so no runtime may be built. */
export class ProductionTransportError extends Error {
  constructor() {
    super(
      "This build cannot connect to a paired computer yet. " +
        "Production connections need the pinned native transport and the Keystore adapter.",
    );
    this.name = "ProductionTransportError";
  }
}

/**
 * Fail-closed runtime factory for production wiring. It throws before any
 * socket, fetch or credential is touched, so the React Native default
 * WebSocket/fetch can never carry pairing material. Pass it as `makeRuntime`
 * until the production runtime wiring lands: a `makeRuntime` over the native
 * pinned WSS adapter, the Keystore adapter behind the directory, and app
 * startup (integration items 1-3 below). The production entry point
 * (`apps/android/index.production.tsx`) stays unpaired for the same reason.
 */
export function failClosedRuntime(_entry: MachineEntry): MachineRuntime {
  throw new ProductionTransportError();
}

export interface MachinesRuntimeOptions {
  directory: MachineRuntimeDirectory;
  /**
   * Build one isolated runtime for `entry`: its own SDK `Client` with its own
   * per-machine `Storage` namespace (outbox plus immutable host binding) and
   * a credential closure that re-reads the device token on every attempt, so
   * revocation and re-pairing take effect without restarting the app. The
   * factory must never share a `Client` or `Storage` between entries, and the
   * production factory must use only the pinned native transport.
   */
  makeRuntime: (entry: MachineEntry) => MachineRuntime;
  /** Runs before a machine's runtime opens, so observers can bind to it. */
  beforeConnect?: (entry: MachineEntry, runtime: MachineRuntime) => void | Promise<void>;
  /** Runs once a removed machine's runtime has stopped and detached. */
  afterRemove?: (hostId: string) => void | Promise<void>;
}

export interface MachinesRuntime {
  /** Last directory listing; empty before the first load. */
  entries(): readonly MachineEntry[];
  entry(hostId: string): MachineEntry | undefined;
  client(hostId: string): MachineRuntime | undefined;
  /** The last per-machine connect failure, if that machine failed to start. */
  failure(hostId: string): unknown;
  /** Whether `(hostId, epoch)` still owns the live runtime; stale callbacks stop. */
  isCurrent(hostId: string, epoch: number): boolean;
  /** The epoch of the live runtime, for callbacks to capture at open. */
  epochOf(hostId: string): number | undefined;
  /**
   * List the directory and reconcile: connect listed machines, stop runtimes
   * the directory no longer lists, restart machines whose target or device
   * changed. A renamed machine keeps its runtime. One machine's failure is
   * recorded under `failure()` and never stops or closes another machine.
   * A close failure keeps that machine's runtime attached and is recorded
   * under `failure()` without touching the others. A directory failure keeps
   * every running runtime and rethrows.
   */
  load(): Promise<readonly MachineEntry[]>;
  /** Re-list and reconcile, like `load()`. */
  refresh(): Promise<readonly MachineEntry[]>;
  /**
   * Connect `entry` beside the others (used after pairing). A machine with
   * the same target and device keeps its runtime; anything else closes the
   * old runtime first, then opens the new one. A close failure keeps the old
   * runtime attached and rethrows, so no second owner is created. A failed
   * replacement re-opens the previous binding when it can, so one bad target
   * does not drop a healthy machine; the replacement error is still thrown
   * and recorded under `failure()`.
   */
  connectEntry(entry: MachineEntry): Promise<MachineRuntime>;
  /**
   * Stop that machine's runtime, remove it from the directory, then detach
   * it. Removal waits for the runtime shutdown first, so the outbox database
   * it holds is never deleted underneath it. A close failure keeps the
   * runtime attached and rethrows before the directory is touched. A failed
   * directory removal reconnects the machine and rethrows the directory
   * error, even when the reconnect also fails. The other machines keep
   * running throughout.
   */
  remove(hostId: string): Promise<void>;
  /**
   * Stop one machine's runtime without touching the directory. A close
   * failure keeps the runtime attached and rethrows.
   */
  disconnect(hostId: string): Promise<void>;
  /**
   * Stop every runtime; the directory listing is kept for inspection.
   * Runtimes that fail to close stay attached and are reported together in
   * an `AggregateError`, so a failed shutdown never strands a runtime the
   * manager can no longer reach.
   */
  disconnectAll(): Promise<void>;
  /**
   * Fan a connectivity change out to every live runtime, from a
   * point-in-time snapshot. One runtime's throw never stops the others.
   */
  setOnline(online: boolean, interfaceChanged?: boolean): void;
  /**
   * Ask every live runtime to check its socket now, from a point-in-time
   * snapshot. One runtime's throw never stops the others.
   */
  wake(): void;
}

interface Session {
  entry: MachineEntry;
  runtime: MachineRuntime;
  epoch: number;
}

export function createMachinesRuntime(options: MachinesRuntimeOptions): MachinesRuntime {
  const directory = options.directory;
  const makeRuntime = options.makeRuntime;
  const sessions = new Map<string, Session>();
  // Monotonic per machine for the life of this manager. Entries are never
  // removed or reset: reusing an epoch would let a stale callback pass
  // `isCurrent` for a newer runtime (ABA), so the map only grows.
  const epochs = new Map<string, number>();
  const failures = new Map<string, unknown>();
  let listed: MachineEntry[] = [];
  let tail: Promise<unknown> = Promise.resolve();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(() => work());
    tail = next.catch(() => {});
    return next;
  }

  function nextEpoch(hostId: string): number {
    const epoch = (epochs.get(hostId) ?? 0) + 1;
    epochs.set(hostId, epoch);
    return epoch;
  }

  /**
   * Re-open the previous binding after a replacement failed. The failed
   * replacement already detached, so this never overlaps two owners: it runs
   * only when the failed attempt holds no live runtime. The replacement
   * error stays in `failure()` even when the rollback succeeds, because the
   * caller still needs to know the new binding did not take.
   */
  async function rollback(
    hostId: string,
    previous: MachineEntry | undefined,
    error: unknown,
  ): Promise<void> {
    if (previous === undefined || previous.hostId !== hostId) {
      failures.set(hostId, error);
      return;
    }
    try {
      await open(previous);
      failures.set(hostId, error);
    } catch (rollbackError) {
      failures.set(
        hostId,
        new AggregateError(
          [error, rollbackError],
          `Replacement failed and the previous runtime could not be restored: ${messageOf(error)}`,
        ),
      );
    }
  }

  async function open(entry: MachineEntry, previous?: MachineEntry): Promise<MachineRuntime> {
    // Close before building: the old runtime owns the per-machine Storage
    // namespace, so a second runtime must never exist beside it. On a close
    // failure the old session is restored untouched (no epoch was minted
    // yet) and the error rethrown: swallowing it here would strand a live
    // runtime the manager can no longer close, and the next open would
    // create a duplicate owner.
    const old = sessions.get(entry.hostId);
    sessions.delete(entry.hostId);
    if (old !== undefined) {
      try {
        await old.runtime.close();
      } catch (error) {
        sessions.set(entry.hostId, old);
        failures.set(entry.hostId, error);
        throw error;
      }
    }
    const epoch = nextEpoch(entry.hostId);
    let runtime: MachineRuntime;
    try {
      runtime = makeRuntime(entry);
    } catch (error) {
      await rollback(entry.hostId, previous ?? old?.entry, error);
      throw error;
    }
    sessions.set(entry.hostId, { entry, runtime, epoch });
    try {
      await options.beforeConnect?.(entry, runtime);
      await runtime.start();
    } catch (error) {
      if (sessions.get(entry.hostId)?.epoch === epoch) {
        sessions.delete(entry.hostId);
      }
      try {
        await runtime.close();
      } catch (closeError) {
        // The failed runtime may still own its resources, so no rollback:
        // reopening now could create a duplicate owner. Surface both errors
        // instead of masking either.
        const combined = new AggregateError(
          [error, closeError],
          `Runtime failed to start and its cleanup also failed: ${messageOf(error)}`,
        );
        failures.set(entry.hostId, combined);
        throw combined;
      }
      await rollback(entry.hostId, previous ?? old?.entry, error);
      throw error;
    }
    failures.delete(entry.hostId);
    return runtime;
  }

  async function reconcile(): Promise<readonly MachineEntry[]> {
    const entries = await directory.load();
    listed = [...entries];
    const stale = new Map<string, MachineEntry>();
    const closeFailed = new Set<string>();
    for (const [hostId, session] of Array.from(sessions)) {
      const current = entries.find((entry) => entry.hostId === hostId);
      if (current === undefined || !sameBinding(session.entry, current)) {
        stale.set(hostId, session.entry);
        try {
          await session.runtime.close();
        } catch (error) {
          // Keep the single owner attached and retry on the next load.
          // Detaching here would strand a runtime the manager can no longer
          // close, and the next load would open a duplicate beside it.
          failures.set(hostId, error);
          closeFailed.add(hostId);
          continue;
        }
        nextEpoch(hostId);
        sessions.delete(hostId);
      }
    }
    for (const entry of entries) {
      if (closeFailed.has(entry.hostId)) continue;
      const session = sessions.get(entry.hostId);
      if (session !== undefined) {
        session.entry = entry;
        failures.delete(entry.hostId);
        continue;
      }
      try {
        await open(entry, stale.get(entry.hostId));
      } catch {
        // Recorded under failure(); the other machines already run.
      }
    }
    return listed;
  }

  const api: MachinesRuntime = {
    entries: () => listed,
    entry: (hostId) => listed.find((entry) => entry.hostId === hostId),
    client: (hostId) => sessions.get(hostId)?.runtime,
    failure: (hostId) => failures.get(hostId),
    isCurrent: (hostId, epoch) => sessions.get(hostId)?.epoch === epoch,
    epochOf: (hostId) => sessions.get(hostId)?.epoch,
    load: () => serialize(() => reconcile()),
    refresh: () => serialize(() => reconcile()),
    connectEntry: (entry) =>
      serialize(async () => {
        const session = sessions.get(entry.hostId);
        if (session !== undefined && sameBinding(session.entry, entry)) {
          session.entry = entry;
          if (!listed.some((known) => known.hostId === entry.hostId)) {
            listed = [...listed, entry];
          } else {
            listed = listed.map((known) => (known.hostId === entry.hostId ? entry : known));
          }
          failures.delete(entry.hostId);
          return session.runtime;
        }
        const runtime = await open(entry, session?.entry);
        if (!listed.some((known) => known.hostId === entry.hostId)) {
          listed = [...listed, entry];
        } else {
          listed = listed.map((known) => (known.hostId === entry.hostId ? entry : known));
        }
        return runtime;
      }),
    remove: (hostId) =>
      serialize(async () => {
        const known = listed.find((entry) => entry.hostId === hostId);
        if (known === undefined) return;
        const session = sessions.get(hostId);
        if (session !== undefined) {
          try {
            await session.runtime.close();
          } catch (error) {
            // Ownership is uncertain, so the directory entry stays: deleting
            // the outbox underneath a still-live runtime is worse than a
            // removal the caller must retry.
            failures.set(hostId, error);
            throw error;
          }
          nextEpoch(hostId);
          sessions.delete(hostId);
        }
        try {
          await directory.remove(hostId);
        } catch (error) {
          // Reconnect best-effort, but the caller must see the directory
          // failure: a reconnect error must never mask it.
          try {
            await open(known);
          } catch (reconnectError) {
            failures.set(hostId, reconnectError);
          }
          throw error;
        }
        listed = listed.filter((entry) => entry.hostId !== hostId);
        failures.delete(hostId);
        await options.afterRemove?.(hostId);
      }),
    disconnect: (hostId) =>
      serialize(async () => {
        const session = sessions.get(hostId);
        if (session === undefined) return;
        try {
          await session.runtime.close();
        } catch (error) {
          failures.set(hostId, error);
          throw error;
        }
        nextEpoch(hostId);
        sessions.delete(hostId);
        failures.delete(hostId);
      }),
    disconnectAll: () =>
      serialize(async () => {
        const live = Array.from(sessions);
        const settled = await Promise.all(
          live.map(async ([hostId, session]) => {
            try {
              await session.runtime.close();
              return { hostId, ok: true as const };
            } catch (error) {
              return { hostId, ok: false as const, error };
            }
          }),
        );
        const errors: unknown[] = [];
        for (const result of settled) {
          if (result.ok) {
            nextEpoch(result.hostId);
            sessions.delete(result.hostId);
            failures.delete(result.hostId);
          } else {
            failures.set(result.hostId, result.error);
            errors.push(result.error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "One or more runtimes failed to close.");
        }
      }),
    setOnline: (online, interfaceChanged = false) => {
      for (const session of Array.from(sessions.values())) {
        try {
          session.runtime.networkOnline(online);
          if (online && interfaceChanged) session.runtime.reconnectNow();
        } catch {
          // Per-machine isolation: one broken runtime never blocks the rest.
        }
      }
    },
    wake: () => {
      for (const session of Array.from(sessions.values())) {
        try {
          session.runtime.wake?.();
        } catch {
          // Per-machine isolation: one broken runtime never blocks the rest.
        }
      }
    },
  };
  return api;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameBinding(a: MachineEntry, b: MachineEntry): boolean {
  return a.deviceId === b.deviceId && sameTarget(a.target, b.target);
}

function sameTarget(a: MachineTarget, b: MachineTarget): boolean {
  if (a.kind !== b.kind || a.url !== b.url) return false;
  if (a.kind === "direct" && b.kind === "direct") return a.fingerprint === b.fingerprint;
  if (a.kind === "relay" && b.kind === "relay") return a.ticketReference === b.ticketReference;
  return false;
}
