import type { SettingsService } from "@ace/settings";
import type {
  ActivityAddress,
  ActivityRegistration,
  LiveActivityTarget,
  PushGatewayTarget,
} from "@ace/notify";
import type { DeviceId, LiveActivitySync } from "@ace/protocol";
import { failureDelay } from "./notification-wake.ts";

/** Where a phone's Live Activity tokens live: the notification worker's store (ADR 0223). */
export interface LiveActivityTokens {
  /** Durable: what the sync leaves out is gone, across the ids that proved one install. */
  sync(
    device: DeviceId,
    linked: readonly DeviceId[],
    input: LiveActivitySync | undefined,
  ): Promise<void>;
  targets(): Promise<LiveActivityTarget[]>;
  clear(): Promise<void>;
  drop(address: Pick<LiveActivityTarget, "token" | "environment" | "kind">): Promise<void>;
}
/** The gateway side this policy needs (`createPushGatewayTransport`). */
export interface LiveActivityGateway {
  registerActivity(address: ActivityAddress, signal: AbortSignal): Promise<ActivityRegistration>;
  /** Drop the cached handle for a token that was removed or that the gateway refused. */
  forgetActivity(address: ActivityAddress): void;
}
export interface LiveActivityOptions {
  tokens: LiveActivityTokens;
  gateway: LiveActivityGateway;
  /** The machine's push switch and gateway origin, read live (ADR 0106). */
  target: () => PushGatewayTarget | Promise<PushGatewayTarget>;
  /** Storage is refused where Live Activities may not be used at all, such as an org host. */
  allowed?: () => boolean | Promise<boolean>;
  /**
   * Whether any id that synced a token is still a current pairing with read access, or an
   * account-only alias the daemon cannot check here. A lapsed pairing must not resume by
   * itself after a restart.
   */
  authorize?: (devices: readonly DeviceId[]) => boolean;
  now: () => number;
  signal: AbortSignal;
  report: (error: unknown) => void;
  delay: (run: () => void, milliseconds: number) => () => void;
  /** A clear or drop the worker did not confirm: the caller's retry lane replays it via resume. */
  cleanupFailed?: () => void;
}
/**
 * A token as one read of the store found it, for a push. `binding` names that read's
 * registration of the token: a sync that removes or replaces it, a drop, a device fence or a
 * clear retires the binding, so a send that obtained the target earlier fails `eligible`.
 */
export type LiveActivitySendTarget = LiveActivityTarget & { readonly binding: number };
export interface LiveActivityRegistrar {
  /** Persists first; the gateway registration runs detached and may fail without failing this. */
  sync(
    device: DeviceId,
    linked: readonly DeviceId[],
    input: LiveActivitySync | undefined,
  ): Promise<void>;
  /** Startup and a settings change back on: clean up, then register what the store holds. */
  resume(): Promise<void>;
  /** The tokens #2760 may push with; empty while push is off or a cleanup is unconfirmed. */
  targets(): Promise<LiveActivityTarget[]>;
  /** The same tokens, each bound to its current registration for `eligible`. */
  sendTargets(): Promise<LiveActivitySendTarget[]>;
  /** Push turned off: forget every handle and drop every stored token. */
  clear(): Promise<void>;
  /** A gateway said this token is gone (410). */
  drop(address: Pick<LiveActivityTarget, "token" | "environment" | "kind">): Promise<void>;
  /** After unregister or revoke: forget handles whose tokens the store no longer holds. */
  forgetMissing(): Promise<void>;
  /**
   * Whether a token may be pushed with right now: still the registration it was read under,
   * unfenced and still authorized. Checked again just before the POST.
   */
  eligible(target: LiveActivitySendTarget): boolean;
  /** A device's cleanup started: no token it synced is used or registered until it is acked. */
  fenceDevice(device: DeviceId): void;
  /** The worker confirmed that device's cleanup: its remaining tokens may be used again. */
  clearFence(device: DeviceId): void;
  stop(): void;
}

const addressKey = (address: Pick<LiveActivityTarget, "token" | "environment" | "kind">) =>
  `${address.kind}\n${address.environment}\n${address.token.toLowerCase()}`;
const activityAddress = (target: LiveActivityTarget): ActivityAddress => ({
  token: target.token,
  environment: target.environment,
  kind: target.kind,
});
const pickAddress = (
  address: Pick<LiveActivityTarget, "token" | "environment" | "kind">,
): Pick<LiveActivityTarget, "token" | "environment" | "kind"> => ({
  token: address.token,
  environment: address.environment,
  kind: address.kind,
});
/** A registration that keeps failing is retried at most this often, then waits for a sync. */
const maxAttempts = 8;
/** A handle is renewed a day before it expires, as alerts' handles are (ADR 0106). */
const renewBeforeMs = 24 * 60 * 60_000;
/** An older gateway is asked again after an hour (spec rule 27). */
const capabilitiesRetryMs = 60 * 60_000;
/** setTimeout holds at most this many milliseconds; longer waits are rescheduled. */
const maxTimerMs = 2 ** 31 - 1;

/**
 * The live registrations for the tokens currently stored: one record per token and kind, so a
 * reply from a registration can be told from a newer one by the record's identity, and a
 * removed token keeps no key or address behind.
 */
interface Current {
  address: ActivityAddress;
  /** The ids the daemon proved one install when the token synced (ADR 0115). */
  devices: readonly DeviceId[];
  /** Aborts this registration when its token leaves, including while it is in flight. */
  controller: AbortController;
  pending?: Promise<void>;
  cancel?: () => void;
  failures: number;
}

/**
 * Registers a machine's Live Activity tokens as their own handle kinds and removes them when the
 * person turns them off (ADR 0223, spec "Tokens"). The store is the source of truth: every pass
 * reads it, so a token that arrived over either of a phone's linked routes is registered once by
 * the gateway's own token-keyed handles. Gateway work is detached from the phone's registration:
 * a gateway that is down, old or refusing never fails the sync that stored the tokens. Durable
 * store changes are serialised, and a settings or organization change to off fences a sync that
 * is still waiting, so turning pushes off cannot leave a token stored or registered after it.
 */
export function createLiveActivityRegistrar(options: LiveActivityOptions): LiveActivityRegistrar {
  const { tokens, gateway, target, allowed, authorize, now, report, delay } = options;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const current = new Map<string, Current>();
  /** Cleanup the worker has not acknowledged; replayed on recovery before anything registers. */
  let clearPending = false;
  const dropPending = new Map<string, Pick<LiveActivityTarget, "token" | "environment" | "kind">>();
  /** Devices whose unregister or revoke is unconfirmed: their tokens stay hidden meanwhile. */
  const fencedDevices = new Set<DeviceId>();
  /** Store writes run in call order, so a clear cannot slip inside a sync that still waits. */
  let durable: Promise<unknown> = Promise.resolve();
  /** Any clear starts a new generation, fencing syncs that began under the old one. */
  let generation = 0;
  /** The store's own revision: a sync or cleanup makes an earlier targets snapshot stale. */
  let revision = 0;
  /** Each stored token's current binding, and the ids that synced it. */
  const bindings = new Map<string, { binding: number; devices: readonly DeviceId[] }>();
  let lastBinding = 0;
  /** No send that read these ids' tokens before now may post with them any more. */
  const unbindDevices = (devices: readonly DeviceId[]) => {
    for (const [key, entry] of bindings)
      if (entry.devices.some((device) => devices.includes(device))) bindings.delete(key);
  };
  let stopped = false;

  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = durable.then(run, run);
    durable = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const settingsTarget = async (): Promise<PushGatewayTarget | undefined> => {
    try {
      return await target();
    } catch (error) {
      report(error);
      return undefined;
    }
  };
  const usable = async (gatewayOrigin?: string) => {
    try {
      if (allowed && !(await allowed())) return false;
    } catch (error) {
      report(error);
      return false;
    }
    const currentTarget = await settingsTarget();
    if (!currentTarget?.enabled) return false;
    return gatewayOrigin === undefined || currentTarget.origin === gatewayOrigin;
  };
  const forget = (address: ActivityAddress) => {
    try {
      gateway.forgetActivity(address);
    } catch (error) {
      report(error);
    }
  };
  /** Drops one token's record: aborts its registration, its retry, and its cached handle. */
  const remove = (key: string) => {
    const record = current.get(key);
    if (!record) return;
    current.delete(key);
    record.controller.abort();
    record.cancel?.();
    delete record.cancel;
    forget(record.address);
  };
  /** Retries cleanup the worker did not confirm. Keeps what failed pending for the next resume. */
  const flushCleanup = async () => {
    try {
      if (clearPending) {
        await serial(() => tokens.clear());
        clearPending = false;
      }
      for (const [key, address] of dropPending) {
        await serial(() => tokens.drop(address));
        dropPending.delete(key);
      }
    } catch (error) {
      options.cleanupFailed?.();
      throw error;
    }
  };
  const schedule = (record: Current, wait: number) => {
    record.cancel?.();
    record.cancel = delay(
      () => {
        delete record.cancel;
        register(record);
      },
      Math.max(0, Math.min(wait, maxTimerMs)),
    );
  };

  const clear = async (): Promise<void> => {
    generation++;
    revision++;
    bindings.clear();
    for (const key of current.keys()) remove(key);
    clearPending = true;
    await flushCleanup();
  };

  const drop = async (
    address: Pick<LiveActivityTarget, "token" | "environment" | "kind">,
  ): Promise<void> => {
    const key = addressKey(address);
    remove(key);
    bindings.delete(key);
    dropPending.set(key, pickAddress(address));
    revision++;
    await flushCleanup();
  };

  const attempt = async (record: Current): Promise<void> => {
    const key = addressKey(record.address);
    if (stopped || current.get(key) !== record) return;
    // An unconfirmed cleanup hides the token; a pairing that has lapsed since (a retry or a
    // renewal can run much later) drops it instead of asking the gateway for a fresh handle.
    if (hidden(record.devices)) return;
    if (authorize && !authorize(record.devices)) {
      await drop(record.address).catch(report);
      return;
    }
    const startedFor = (await settingsTarget())?.origin;
    // Eligibility can change while that read waits: no HTTP for a token that may no longer be
    // stored, or a machine that may no longer push.
    if (stopped || current.get(key) !== record || hidden(record.devices)) return;
    if (!(await usable())) return;
    if (stopped || current.get(key) !== record || hidden(record.devices)) return;
    const request = AbortSignal.any([signal, record.controller.signal]);
    let result: ActivityRegistration;
    try {
      result = await gateway.registerActivity(record.address, request);
    } catch (error) {
      report(error);
      result = { status: "retry" };
    }
    if (stopped) return;
    // Removed, or replaced by a newer sync, while this was in flight.
    if (current.get(key) !== record) {
      // A reply for a token no one wants back must not leave a handle cached for it.
      if (result.status === "registered" && !current.has(key)) forget(record.address);
      return;
    }
    switch (result.status) {
      case "registered":
        record.failures = 0;
        // A phone that stays disconnected still has its handle renewed before it expires. A
        // gateway that reports a very short or past expiry is retried no faster than a minute.
        schedule(record, Math.max(60_000, result.expiresAt - renewBeforeMs - now()));
        return;
      case "disabled":
        // Push is off: what was stored for it must not outlive the switch.
        await clear().catch(report);
        return;
      case "unsupported":
        // An older gateway keeps alerts working; ask again when its capabilities may have changed.
        schedule(record, capabilitiesRetryMs);
        return;
      case "failed":
        // A permanent refusal is tried again by the next sync.
        return;
      case "gone": {
        // A reply from a gateway the daemon has since left must not delete a current token;
        // nor one whose record or device eligibility changed while that read waited.
        const latest = (await settingsTarget())?.origin;
        if (stopped || current.get(key) !== record || hidden(record.devices)) return;
        if (latest !== undefined && startedFor !== undefined && latest !== startedFor) return;
        await drop(record.address).catch(report);
        return;
      }
      case "retry":
        record.failures++;
        if (record.failures > maxAttempts) return;
        schedule(record, result.retryAfterMs ?? failureDelay(record.failures));
        return;
    }
  };

  const register = (record: Current) => {
    if (record.pending || record.cancel) return;
    const key = addressKey(record.address);
    record.pending = attempt(record)
      .catch(report)
      .finally(() => {
        if (current.get(key) === record) delete record.pending;
      });
  };

  const hidden = (devices: readonly DeviceId[]) =>
    devices.some((device) => fencedDevices.has(device));

  const registerStored = async (): Promise<void> => {
    if (stopped || clearPending || dropPending.size > 0) return;
    if (!(await usable())) {
      // Push is off or this host may not use Live Activities: nothing that was stored stays.
      if (!stopped) await clear().catch(report);
      return;
    }
    if (stopped || clearPending) return;
    // A snapshot is only usable while no sync or cleanup has changed the store since it began:
    // an older pass must never recreate a record a later clear removed.
    const snapshot = revision;
    const targets = await tokens.targets();
    if (stopped || clearPending || snapshot !== revision) return;
    // The eligibility that was true before that read may have changed while it waited.
    if (!(await usable())) {
      if (!stopped) await clear().catch(report);
      return;
    }
    if (snapshot !== revision) return;
    // Dropped after the pass: a drop moves the revision, which would end it before the other
    // phones' tokens register.
    const lapsed: LiveActivityTarget[] = [];
    for (const entry of targets) {
      if (stopped || clearPending || snapshot !== revision) break;
      const key = addressKey(entry);
      // A pairing that lapsed while the daemon was down gives nothing to the gateway any more.
      if (authorize && !authorize(entry.devices)) {
        lapsed.push(entry);
        continue;
      }
      // An unconfirmed unregister or revoke keeps what that device synced out of reach.
      if (hidden(entry.devices) || dropPending.has(key)) continue;
      let record = current.get(key);
      if (record) {
        // The newest sync's ids are the current proof, so a renewed account alias can carry
        // the token after its original pairing expires.
        record.devices = entry.devices;
      } else {
        record = {
          address: activityAddress(entry),
          devices: entry.devices,
          controller: new AbortController(),
          failures: 0,
        };
        current.set(key, record);
      }
      // Still the current record and still authorized at the moment registration starts.
      if (current.get(key) !== record || hidden(record.devices)) continue;
      if (authorize && !authorize(record.devices)) {
        lapsed.push(entry);
        continue;
      }
      register(record);
    }
    for (const entry of lapsed) {
      if (stopped) return;
      await drop(entry).catch(report);
    }
  };

  const forgetMissing = async (): Promise<void> => {
    if (stopped) return;
    const targets = await tokens.targets();
    if (stopped) return;
    const present = new Set(targets.map(addressKey));
    for (const key of current.keys()) if (!present.has(key)) remove(key);
    for (const key of bindings.keys()) if (!present.has(key)) bindings.delete(key);
  };

  const readTargets = async (): Promise<LiveActivityTarget[]> => {
    if (stopped || clearPending) return [];
    if (!(await usable())) return [];
    const snapshot = revision;
    const stored = await tokens.targets();
    // A clear or sync that finished while this read waited makes the answer stale.
    if (stopped || clearPending || snapshot !== revision) return [];
    return stored.filter(
      (entry) =>
        !dropPending.has(addressKey(entry)) &&
        !hidden(entry.devices) &&
        (!authorize || authorize(entry.devices)),
    );
  };

  const resume = async (): Promise<void> => {
    if (stopped) return;
    await flushCleanup();
    await forgetMissing();
    await registerStored();
  };

  return {
    async sync(device, linked, input) {
      // Push off, or a host that may not use Live Activities, stores nothing.
      const startedAt = generation;
      if (!(await usable())) {
        if (!stopped) await clear().catch(report);
        return;
      }
      if (stopped || startedAt !== generation) return;
      // Durable before the phone hears its registration succeeded. Queued, so a clear ordered
      // after it removes the rows this writes; a clear ordered before it makes this return. The
      // eligibility is read again inside the queue, after any earlier write it waited for.
      await serial(async () => {
        if (stopped || startedAt !== generation) return;
        if (!(await usable())) return;
        // Retired before the write: once it lands, a send holding a removed or replaced token
        // of this install must not post, and a targets read already under way is stale.
        unbindDevices([device, ...linked]);
        revision++;
        await tokens.sync(device, linked, input);
        // The newest sync replaces what any earlier snapshot read, including a same-token one
        // whose device association changed.
        revision++;
      });
      if (stopped || startedAt !== generation) return;
      if (!(await usable())) {
        // Turned off while the write waited: the rows this build may have written must go.
        await clear().catch(report);
        return;
      }
      // The tokens are durable now: a cleanup read that fails must not fail the phone's ack.
      await forgetMissing().catch(report);
      void registerStored().catch(report);
    },
    resume,
    targets: readTargets,
    async sendTargets() {
      const snapshot = revision;
      const stored = await readTargets();
      if (stopped || snapshot !== revision) return [];
      return stored.map((entry) => {
        const key = addressKey(entry);
        let bound = bindings.get(key);
        if (!bound) {
          bound = { binding: ++lastBinding, devices: entry.devices };
          bindings.set(key, bound);
        } else {
          bound.devices = entry.devices;
        }
        return Object.assign(entry, { binding: bound.binding });
      });
    },
    clear,
    drop,
    forgetMissing,
    eligible(address) {
      return (
        !stopped &&
        !clearPending &&
        bindings.get(addressKey(address))?.binding === address.binding &&
        !dropPending.has(addressKey(address)) &&
        !hidden(address.devices) &&
        (!authorize || authorize(address.devices))
      );
    },
    fenceDevice(device) {
      // A snapshot that began before the fence, or while it was set, must not survive its
      // removal: the revision makes that pass stale rather than recreating a deleted target.
      revision++;
      unbindDevices([device]);
      fencedDevices.add(device);
      for (const [key, record] of current) if (record.devices.includes(device)) remove(key);
    },
    clearFence(device) {
      revision++;
      fencedDevices.delete(device);
    },
    stop() {
      stopped = true;
      generation++;
      for (const key of current.keys()) remove(key);
      bindings.clear();
      fencedDevices.clear();
      lifetime.abort();
    },
  };
}

/** The setting that turns pushes off for every phone of this machine (ADR 0106). */
export type RemotePushSettings = Pick<SettingsService, "get" | "subscribe">;
/**
 * Follows `notifications.remotePush` after startup: off clears the stored tokens at once, on
 * registers what is still stored, without waiting for the phone to sync again.
 */
export async function followRemotePushSetting(
  settings: RemotePushSettings,
  apply: (enabled: boolean) => void | Promise<void>,
  report: (error: unknown) => void,
): Promise<() => void> {
  return settings.subscribe({ keys: ["notifications.remotePush"], scope: {} }, (notification) => {
    if (notification.type !== "changed") return;
    const entry = notification.entries.find(
      (candidate) => candidate.key === "notifications.remotePush",
    );
    if (!entry) return;
    void Promise.resolve(apply(entry.value !== false)).catch(report);
  });
}
