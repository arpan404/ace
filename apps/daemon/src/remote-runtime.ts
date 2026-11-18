import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import type { RequestListener, Server } from "node:http";
import { SettingsValues } from "@ace/protocol";
import { SettingsError, transportNetworks } from "@ace/settings";
import { defaults } from "@ace/settings/defaults";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { relayPairing, relayRoute } from "./relay-route.ts";
import { computerName } from "./computer-name.ts";
import { remoteDirect } from "./remote-direct.ts";
import { remoteRelays } from "./remote-relays.ts";
import { startRelayTransport } from "./services/transports.ts";
import { remoteNetworksStatus } from "./remote-status.ts";
import type { ReachFacts } from "./external-mcp/reach.ts";
import { shutdownDeadline } from "./shutdown.ts";
import { logFields } from "@ace/diagnostics";
import type { DirectNetwork } from "./remote-direct-policy.ts";
import {
  addedDirect,
  remotePlan,
  remotePreferenceKeys,
  type RemotePlan,
  type RemotePreferences as Preferences,
} from "./remote-policy.ts";

/** Settings this runtime applies: the networks, and the older single choice it translates. */
const keys = [...remotePreferenceKeys, "remote.transport"] as const;
/** How long making a pairing link waits on a Tailscale certificate fetched again for it. */
const pairingCertificateWaitMs = 15_000;
/**
 * How long making a pairing link waits on remote access still starting: the direct listener, then,
 * with no direct address, the person's own relay. Past it the link names what serves by then.
 */
export const pairingStartWaitMs = 15_000;
/** How often the address remote access listens on is checked against the network's. */
export const addressCheckMs = 30_000;
/**
 * How long closing waits for remote access's queued work (a settings change, a check) and then
 * for the relays to stop. Registrations under way are aborted first, so this is only a backstop:
 * shutdown never waits on the network (ADR 0170).
 */
export const remoteCloseWaitMs = 2_000;
/** What status says while the saved remote settings can't be read; access stays off meanwhile. */
export const settingsUnreadable =
  "Couldn't read the remote access settings, so remote access is off for now. ace tries again on its own; if this keeps up, restart ace.";
const Stored = SettingsValues.pick({
  "remote.enabled": true,
  "remote.lan": true,
  "remote.tailscale": true,
  "remote.relay": true,
  "remote.relayUrl": true,
});

/**
 * Owns network resources separately from local sessions and their event history: the direct
 * listener (LAN and Tailscale) and every relay, each run together and failing on its own
 * (ADR 0112).
 */
export function remoteRuntime(
  options: ServerOptions,
  auth: RemoteAuth,
  http: RequestListener,
  attach: (server: Server) => void,
  disconnect: () => void,
) {
  options.relay = undefined;
  const delay = options.runtime?.delay ?? systemDeliveryRuntime.delay;
  const every = options.runtime?.every ?? systemDeliveryRuntime.every;
  const now = options.now ?? options.runtime?.now ?? systemDeliveryRuntime.now;
  // The first pass, which the daemon no longer waits for before it listens: the direct
  // listener's part, and every network's. Both settle, never reject, and settle on close.
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
  // Until the saved settings are read, the defaults (remote access on, the LAN only).
  let preferences: Preferences = Stored.parse(defaults);
  let closed = false;
  let tail = Promise.resolve();
  let stop: (() => void) | undefined;
  let queued = 0;
  let stopAccount: (() => void) | undefined;
  let reconciling = false;
  let dirty = false;
  // Whether the saved settings were read once: until then nothing opens, and status says why.
  let loaded = false;
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
  const direct = remoteDirect({ options, http, attach, disconnect, clearPending });
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
      void serialize(() => (loaded ? apply(preferences) : sync())).catch(recover);
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
  const read = async (base: Preferences): Promise<Preferences> => {
    const entries = (await options.settings?.read({ keys: [...remotePreferenceKeys], scope: {} }))
      ?.entries;
    const next: Record<string, unknown> = { ...base };
    for (const entry of entries ?? []) next[entry.key] = entry.value;
    const parsed = Stored.safeParse(next);
    return parsed.success ? parsed.data : base;
  };
  /**
   * Reads the saved choice and brings the networks to it. Until a read succeeds once, remote
   * access stays off, status says why, and the retry timer reads again.
   */
  const sync = async (retryRefused = false): Promise<void> => {
    let next: Preferences;
    try {
      next = await read(preferences);
    } catch (failure) {
      if (loaded) throw failure;
      if (unreadable === undefined)
        options.log?.(new Error(settingsUnreadable, { cause: failure }));
      unreadable = settingsUnreadable;
      scheduleRetry();
      return;
    }
    loaded = true;
    unreadable = undefined;
    await apply(next, undefined, retryRefused);
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
      options.settings?.subscribe({ keys: [...keys], scope: {} }, (event) => {
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
    // Signing in, out or to another account changes ace's relay registration; a refusal
    // waiting for a sign-in is tried again.
    stopAccount = options.machineAccount?.onChange(() => {
      if (closed) return;
      retry?.();
      retry = undefined;
      void serialize(() => (loaded ? apply(preferences, undefined, true) : sync(true))).catch(
        recover,
      );
    });
    stopWatch = every(() => {
      if (direct.open() && !closed) void serialize(() => apply(preferences)).catch(recover);
    }, addressCheckMs);
  };
  const begin = async () => {
    await watch();
    if (closed) return;
    await serialize(() => sync()).catch(recover);
  };
  /** Waits on `task` while closing, at most `remoteCloseWaitMs`; overrunning is logged. */
  const bounded = (name: string, task: Promise<unknown>) =>
    shutdownDeadline(name, task, delay, remoteCloseWaitMs).catch((error: unknown) =>
      options.log?.(error instanceof Error ? error : new Error(String(error))),
    );
  /** Stops remote access within a bounded time; a second call waits on the first. */
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
      await bounded("Remote access queue", tail);
      await bounded("Remote relays", relaysClosed);
      await direct.close();
    })());
  const giveUp = () => void close();
  return {
    /**
     * What a pairing link names: the direct address while LAN or Tailscale serves, else the
     * person's own relay (ADR 0070). ace's relay admits account devices only, which never pair.
     */
    /**
     * Before a link is made: waits for remote access still starting (the direct listener, then,
     * with no direct address, the relays), at most `pairingStartWaitMs`, then fetches a failed
     * Tailscale certificate again (`refreshCertificate`).
     */
    beforePairing: async () => {
      const deadline = Promise.withResolvers<void>();
      const cancel = delay(() => deadline.resolve(), pairingStartWaitMs);
      try {
        await Promise.race([directStarted.promise, deadline.promise]);
        if (!direct.open()) await Promise.race([networksStarted.promise, deadline.promise]);
      } finally {
        cancel();
      }
      await direct.refreshCertificate(pairingCertificateWaitMs);
    },
    /** Settles once the direct listener's first start ended, or remote access closed. */
    directStarted: directStarted.promise,
    /** Settles once every network's first start ended, or remote access closed. */
    started: networksStarted.promise,
    pairing: () => {
      const own = relays.selfHosted() && options.relay ? relayPairing(options.relay) : undefined;
      const address = direct.connection();
      // A direct link also names the person's own relay, so a machine that can't reach the
      // address can still redeem it there (ADR 0182).
      if (address) return own ? { ...address, alsoRelay: own.relay } : address;
      return own;
    },
    status: () => {
      const config = options.remoteConfig;
      const networks = remoteNetworksStatus({
        direct: {
          serving: direct.serving(),
          errors: direct.errors(),
          warnings: direct.warnings(),
          address: direct.address,
        },
        relays: relays.view(),
        ...(pending ? { pending } : {}),
      });
      const error = unreadable ?? networks.error;
      return {
        ...networks,
        ...(error ? { error } : {}),
        listenOverride: config?.listenOverride ? config.listen : null,
        relayOverride: config?.relayUrl !== undefined,
        ...(options.relay ? relayRoute(options.relay, options.hostId) : {}),
      };
    },
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
    /** Where outside MCP clients can reach this machine beyond loopback (ADR 0122). */
    outsideReach: (): ReachFacts => ({
      tailscale: () =>
        direct.tailnet() ?? {
          problem:
            direct.errors().tailscale ??
            direct.warnings().tailscale ??
            (direct.serving().tailscale
              ? "Tailscale hasn't issued this machine's HTTPS certificate yet."
              : "Turn on Tailscale in Remote access."),
        },
      relay: () => {
        const hosted = relays.hosted();
        if (!hosted)
          return { problem: "Sign in to an ace account and turn on ace's relay in Remote access." };
        const url = new URL(hosted.url);
        const scheme = url.protocol === "ws:" ? "http:" : "https:";
        return { origin: `${scheme}//${url.host}`, hostId: hosted.hostId };
      },
    }),
    set(key: string, value: unknown, commit: () => Promise<void>) {
      if (!keys.some((item) => item === key)) return commit();
      return serialize(async () => {
        retry?.();
        retry = undefined;
        // Applied on top of the saved choice, never on the defaults standing in for it.
        if (!loaded) {
          preferences = await read(preferences).catch(() => {
            throw new SettingsError("io", settingsUnreadable);
          });
          loaded = true;
          unreadable = undefined;
        }
        const before = preferences;
        // An older app's single network choice becomes the networks it meant.
        const change =
          key === "remote.transport"
            ? transportNetworks(
                SettingsValues.shape["remote.transport"].parse(value),
                before["remote.relayUrl"],
              )
            : { [key]: value };
        try {
          await apply(Stored.parse({ ...before, ...change }), before);
          await commit();
        } catch (failure) {
          await apply(before).catch(recover);
          throw failure;
        }
        // The saved settings are the truth: a write may have changed others with it.
        const saved = await read(preferences);
        if (JSON.stringify(saved) !== JSON.stringify(preferences)) await apply(saved);
      });
    },
    close,
  };
}
