import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import type { RequestListener, Server } from "node:http";
import { SettingsError } from "@ace/settings";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { computerName } from "./computer-name.ts";
import { remoteDirect } from "./remote-direct.ts";
import { remoteRelays } from "./remote-relays.ts";
import type { SniListener, SniListenerOptions } from "./sni-listener.ts";
import { startRelayTransport } from "./services/transports.ts";
import { remoteRuntimeView } from "./remote-runtime-view.ts";
import { shutdownDeadline } from "./shutdown.ts";
import { logFields } from "@ace/diagnostics";
import type { DirectNetwork } from "./remote-direct-policy.ts";
import {
  addedDirect,
  remotePlan,
  type RemotePlan,
  type RemotePreferences as Preferences,
} from "./remote-policy.ts";

import {
  defaultRemotePreferences,
  readRemotePreferences,
  remotePreferenceChange,
  remoteSettingKeys,
  StoredRemotePreferences,
} from "./remote-preferences.ts";

export { pairingStartWaitMs } from "./remote-runtime-view.ts";

/** How often the address remote access listens on is checked against the network's. */
export const addressCheckMs = 30_000;
/** Bounds the drain of the settings queue and relay registrations (ADR 0170). */
export const remoteCloseWaitMs = 2_000;
/** What status says while the saved remote settings can't be read; access stays off meanwhile. */
export const settingsUnreadable =
  "Couldn't read the remote access settings, so remote access is off for now. ace tries again on its own; if this keeps up, restart ace.";
/** What status says while a saved change to remote access can't be read yet. */
export const settingsChangeUnreadable =
  "Couldn't read the latest remote access settings, so a change may not have taken effect yet. ace tries again on its own; if this keeps up, restart ace.";

/** Owns the direct listener and relay registrations independently of local sessions (ADR 0112). */
export function remoteRuntime(
  options: ServerOptions,
  auth: RemoteAuth,
  http: RequestListener,
  attach: (server: Server) => void,
  disconnect: () => void,
  /** Makes the HTTPS listener: the native one under the switch, `sniListener` otherwise. */
  listener?: (options: SniListenerOptions) => SniListener,
) {
  options.relay = undefined;
  const delay = options.runtime?.delay ?? systemDeliveryRuntime.delay;
  const every = options.runtime?.every ?? systemDeliveryRuntime.every;
  const now = options.now ?? options.runtime?.now ?? systemDeliveryRuntime.now;
  // Startup runs in the background. These also settle on close.
  const directStarted = Promise.withResolvers<void>();
  const networksStarted = Promise.withResolvers<void>();
  let firstPass = true;
  const startedLine = (network: string, state: string, durationMs: number, error?: string) =>
    options.info?.(
      "Remote access started",
      logFields([
        ["network", network],
        ["state", state],
        ["durationMs", Math.round(durationMs)],
        ...(error ? [["error", error] as const] : []),
      ]),
    );
  let stopWatch: (() => void) | undefined;
  let retry: (() => void) | undefined;
  let retryMs = 1000;
  let preferences = defaultRemotePreferences();
  let closed = false;
  let tail = Promise.resolve();
  let stop: (() => void) | undefined;
  let queued = 0;
  let stopAccount: (() => void) | undefined;
  let reconciling = false;
  let dirty = false;
  let loaded = false;
  // Whether the saved settings must be read again before anything is applied: until the first
  // read, and after any read that failed. Every retry reads while it is set, never applying the
  // last choice it knows, which a saved change (remote access turned off) may have replaced.
  let stale = true;
  let unreadable: string | undefined;
  // What the change under way brings up: each of its networks reads `waiting` until it serves.
  let pending: RemotePlan | undefined;
  let closing: Promise<void> | undefined;
  const serialize = (run: () => Promise<void>) => {
    if (queued >= 64)
      return Promise.reject(new SettingsError("limit", "Remote access is busy. Try again."));
    queued++;
    const next = tail.then(run).finally(() => {
      queued--;
    });
    tail = next.catch(() => {});
    return next;
  };
  const clearPending = () => {
    if (!closed) auth.clearPending();
  };
  // How this machine is labelled in the account's machine list, as host.identity names it.
  const machineName = async () => {
    const saved = await options.settings?.get("host.displayName").catch(() => undefined);
    if (typeof saved?.value === "string" && saved.value) return saved.value;
    return options.hostName ?? (await computerName().catch(() => undefined));
  };
  const direct = remoteDirect({
    options,
    http,
    attach,
    disconnect,
    clearPending,
    ...(listener === undefined ? {} : { listener }),
  });
  // Links name the relay only while no direct address serves; then closing it withdraws them.
  const relays = remoteRelays({
    options,
    connect: (relay, access) => startRelayTransport(options, auth, relay, access),
    machineName,
    serialize,
    clearPending: () => {
      if (!direct.open()) clearPending();
    },
    now,
    // Each network's first start says how long it took, so a slow start explains itself.
    onSettled: (relay, durationMs) => {
      if (firstPass)
        startedLine(
          relay.plan.hosted ? "ace relay" : "own relay",
          relay.state,
          durationMs,
          relay.error,
        );
    },
  });
  const accountId = () => options.machineAccount?.account()?.id;
  const plan = (next: Preferences): RemotePlan | undefined => {
    const config = options.remoteConfig;
    return config ? remotePlan(config, next, accountId()) : undefined;
  };
  const scheduleRetry = () => {
    if (closed || retry) return;
    retry = delay(() => {
      retry = undefined;
      void serialize(() => (stale ? sync() : apply(preferences))).catch(recover);
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  };
  /**
   * Brings every network to `next`. With `refuseFrom`, a network this change turns on that can't
   * start refuses the change before anything is taken down: the person learns now, and the
   * networks already serving stay as they were. Otherwise failures show in status and retry.
   */
  const apply = async (
    next: Preferences,
    refuseFrom?: Preferences,
    retryRefused = false,
  ): Promise<void> => {
    if (closed) return;
    const wanted = plan(next);
    if (!wanted) return;
    pending = wanted;
    try {
      await bringUp(wanted, next, refuseFrom, retryRefused);
    } finally {
      if (pending === wanted) pending = undefined;
    }
  };
  const bringUp = async (
    wanted: RemotePlan,
    next: Preferences,
    refuseFrom: Preferences | undefined,
    retryRefused: boolean,
  ): Promise<void> => {
    const began = now();
    const resolution = await direct.resolve(wanted.direct);
    if (refuseFrom) {
      const before = plan(refuseFrom);
      const added = before ? addedDirect(before.direct, wanted.direct) : wanted.direct;
      for (const network of ["tailscale", "lan"] as const) {
        const read = resolution[network];
        if (added[network] && read instanceof Error) throw read;
      }
    }
    if (closed) return;
    preferences = next;
    await direct.commit(resolution);
    if (firstPass && !refuseFrom) {
      const errors = direct.errors();
      for (const network of ["lan", "tailscale"] as const satisfies DirectNetwork[])
        if (wanted.direct[network])
          startedLine(
            network,
            errors[network] ? "failed" : direct.serving()[network] ? "on" : "off",
            now() - began,
            errors[network],
          );
      directStarted.resolve();
    }
    if (closed) return;
    await relays.apply(wanted.relays, retryRefused);
    if (!refuseFrom) firstPass = false;
    if (refuseFrom) {
      const before = plan(refuseFrom);
      const addedDirectNetworks = before
        ? addedDirect(before.direct, wanted.direct)
        : wanted.direct;
      const listening = (["tailscale", "lan"] as const).find(
        (network) => addedDirectNetworks[network] && direct.errors()[network],
      );
      if (listening) throw new SettingsError("io", direct.errors()[listening] ?? "");
      const added = wanted.relays.find(
        (relay) =>
          !relay.hosted &&
          relays.failed(relay.key) &&
          !before?.relays.some((old) => old.key === relay.key),
      );
      if (added)
        throw new SettingsError(
          "io",
          "Couldn't start remote access through that relay. Check its address and try again.",
        );
    }
    const directErrors = Object.values(direct.errors());
    for (const error of directErrors) options.log?.(new Error(error));
    const directFailed = directErrors.length > 0;
    if (directFailed || relays.retryable()) scheduleRetry();
    else retryMs = 1000;
  };
  const recover = (failure: unknown) => {
    const message =
      failure instanceof SettingsError
        ? failure.message
        : "Couldn't start remote access. Check your network or relay address.";
    options.log?.(new Error(message));
    scheduleRetry();
  };
  // A failed read leaves the settings stale and schedules recovery.
  const readSaved = async (): Promise<Preferences> => {
    try {
      const next = await readRemotePreferences(options.settings, preferences);
      stale = false;
      loaded = true;
      unreadable = undefined;
      return next;
    } catch (failure) {
      stale = true;
      const message = loaded ? settingsChangeUnreadable : settingsUnreadable;
      if (unreadable !== message) options.log?.(new Error(message, { cause: failure }));
      unreadable = message;
      scheduleRetry();
      throw new SettingsError("io", message);
    }
  };
  const sync = async (retryRefused = false): Promise<void> => {
    const next = await readSaved().catch(() => undefined);
    if (next) await apply(next, undefined, retryRefused);
  };
  const reconcile = () => {
    dirty = true;
    if (reconciling || closed) return;
    reconciling = true;
    void serialize(async () => {
      while (dirty) {
        if (closed) break;
        dirty = false;
        await sync();
      }
    })
      .catch(recover)
      .finally(() => {
        reconciling = false;
        if (dirty && !closed) reconcile();
      });
  };
  /**
   * Follows settings, the account and the network's address. Installed before the first start,
   * so a sign-in, sign-out or settings change while it waits on the network is applied, in
   * order, once it ends.
   */
  const watch = async () => {
    const unsubscribe = await Promise.resolve(
      options.settings?.subscribe({ keys: [...remoteSettingKeys], scope: {} }, (event) => {
        if (event.type === "changed") reconcile();
      }),
    ).catch((failure: unknown) => {
      // The retry timer and the account still bring remote access up to date.
      options.log?.(failure);
      return undefined;
    });
    // Closed while subscribing: nothing is left listening.
    if (closed) {
      unsubscribe?.();
      return;
    }
    stop = unsubscribe;
    // An account change retries ace's relay registration.
    stopAccount = options.machineAccount?.onChange(() => {
      if (closed) return;
      retry?.();
      retry = undefined;
      void serialize(() => (stale ? sync(true) : apply(preferences, undefined, true))).catch(
        recover,
      );
    });
    stopWatch = every(() => {
      if (direct.open() && !closed)
        void serialize(() => (stale ? sync() : apply(preferences))).catch(recover);
    }, addressCheckMs);
  };
  const begin = async () => {
    await watch();
    if (closed) return;
    await serialize(() => sync()).catch(recover);
  };
  const bounded = (name: string, task: Promise<unknown>) =>
    shutdownDeadline(name, task, delay, remoteCloseWaitMs).catch((error: unknown) =>
      options.log?.(error instanceof Error ? error : new Error(String(error))),
    );
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      closed = true;
      firstPass = false;
      directStarted.resolve();
      networksStarted.resolve();
      stopAccount?.();
      stopWatch?.();
      stopWatch = undefined;
      retry?.();
      retry = undefined;
      stop?.();
      // Relays first: a registration the relay never answers is given up now, so the queued
      // work waiting on it ends, instead of shutdown waiting out its deadline. The relay expires
      // a registration that never finished; the next start registers afresh.
      const relaysClosed = relays.close(false);
      // Drop direct HTTP exchanges before they can reply during the remaining shutdown work.
      await Promise.all([
        direct.close(),
        bounded("Remote access queue", tail).then(() => bounded("Remote relays", relaysClosed)),
      ]);
    })());
  const giveUp = () => void close();
  return {
    ...remoteRuntimeView({
      options,
      direct,
      relays,
      delay,
      directStarted: directStarted.promise,
      networksStarted: networksStarted.promise,
      pendingPlan: () => pending,
      settingsError: () => unreadable,
    }),
    async start() {
      // A stop while starting closes now: what waits on the network is given up, not awaited.
      const lifetime = options.lifetime;
      lifetime?.addEventListener("abort", giveUp, { once: true });
      try {
        if (lifetime?.aborted) await close();
        else if (options.remoteConfig) await begin();
      } finally {
        lifetime?.removeEventListener("abort", giveUp);
        // A first pass that ended early (the saved settings unreadable) leaves nothing to wait
        // for; its networks log their start once a later pass brings them up.
        directStarted.resolve();
        networksStarted.resolve();
      }
    },
    get relayHostId() {
      return relays.relayHostId();
    },
    set(key: string, value: unknown, commit: () => Promise<void>) {
      if (!remoteSettingKeys.some((item) => item === key)) return commit();
      return serialize(async () => {
        retry?.();
        retry = undefined;
        // Read stale preferences before applying a write.
        if (stale) preferences = await readSaved();
        const before = preferences;
        const change = remotePreferenceChange(before, key, value);
        try {
          await apply(StoredRemotePreferences.parse({ ...before, ...change }), before);
          await commit();
        } catch (failure) {
          await apply(before).catch(recover);
          throw failure;
        }
        // The saved settings are the truth: a write may have changed others with it.
        const saved = await readSaved();
        if (JSON.stringify(saved) !== JSON.stringify(preferences)) await apply(saved);
      });
    },
    close,
  };
}
