import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import type { RequestListener, Server } from "node:http";
import { SettingsValues } from "@ace/protocol";
import { SettingsError, transportNetworks } from "@ace/settings";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { relayPairing, relayRoute } from "./relay-route.ts";
import { computerName } from "./computer-name.ts";
import { remoteDirect } from "./remote-direct.ts";
import { remoteRelays } from "./remote-relays.ts";
import { remoteNetworksStatus } from "./remote-status.ts";
import {
  addedDirect,
  remotePlan,
  remotePreferenceKeys,
  type RemotePlan,
  type RemotePreferences as Preferences,
} from "./remote-policy.ts";

/** Settings this runtime applies: the networks, and the older single choice it translates. */
const keys = [...remotePreferenceKeys, "remote.transport"] as const;
/** How often the address remote access listens on is checked against the network's. */
export const addressCheckMs = 30_000;
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
  let stopWatch: (() => void) | undefined;
  let retry: (() => void) | undefined;
  let retryMs = 1000;
  let preferences: Preferences = Stored.parse({
    "remote.enabled": false,
    "remote.lan": true,
    "remote.tailscale": false,
    "remote.relay": false,
    "remote.relayUrl": "",
  });
  let closed = false;
  let tail = Promise.resolve();
  let stop: (() => void) | undefined;
  let queued = 0;
  let stopAccount: (() => void) | undefined;
  let reconciling = false;
  let dirty = false;
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
    auth,
    machineName,
    serialize,
    clearPending: () => {
      if (!direct.open()) clearPending();
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
      void serialize(() => apply(preferences)).catch(recover);
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
    try {
      await direct.commit(resolution);
    } catch {
      throw new SettingsError(
        "io",
        "Couldn't start remote access. Check the selected network and try again.",
      );
    } finally {
      preferences = next;
    }
    await relays.apply(wanted.relays, retryRefused);
    if (refuseFrom) {
      const before = plan(refuseFrom);
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
  return {
    /**
     * What a pairing link names: the direct address while LAN or Tailscale serves, else the
     * person's own relay (ADR 0070). ace's relay admits account devices only, which never pair.
     */
    pairing: () =>
      direct.connection() ??
      (relays.selfHosted() && options.relay ? relayPairing(options.relay) : undefined),
    status: () => {
      const config = options.remoteConfig;
      const networks = remoteNetworksStatus({
        direct: { serving: direct.serving(), errors: direct.errors(), address: direct.address },
        relays: relays.view(),
      });
      return {
        ...networks,
        listenOverride: config?.listenOverride ? config.listen : null,
        relayOverride: config?.relayUrl !== undefined,
        ...(options.relay ? relayRoute(options.relay, options.hostId) : {}),
      };
    },
    async start() {
      if (!options.remoteConfig) return;
      preferences = await read(preferences);
      await serialize(() => apply(preferences)).catch(recover);
      const reconcile = () => {
        dirty = true;
        if (reconciling || closed) return;
        reconciling = true;
        void serialize(async () => {
          while (dirty) {
            if (closed) break;
            dirty = false;
            await apply(await read(preferences));
          }
        })
          .catch(recover)
          .finally(() => {
            reconciling = false;
            if (dirty && !closed) reconcile();
          });
      };
      stop = await options.settings?.subscribe({ keys: [...keys], scope: {} }, (event) => {
        if (event.type === "changed") reconcile();
      });
      // Signing in, out or to another account changes ace's relay registration; a refusal
      // waiting for a sign-in is tried again.
      stopAccount = options.machineAccount?.onChange(() => {
        if (closed) return;
        retry?.();
        retry = undefined;
        void serialize(() => apply(preferences, undefined, true)).catch(recover);
      });
      if (!closed)
        stopWatch = every(() => {
          if (direct.open() && !closed) void serialize(() => apply(preferences)).catch(recover);
        }, addressCheckMs);
    },
    get relayHostId() {
      return relays.relayHostId();
    },
    set(key: string, value: unknown, commit: () => Promise<void>) {
      if (!keys.some((item) => item === key)) return commit();
      return serialize(async () => {
        retry?.();
        retry = undefined;
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
    async close() {
      closed = true;
      stopAccount?.();
      stopWatch?.();
      stopWatch = undefined;
      retry?.();
      retry = undefined;
      stop?.();
      await tail;
      await relays.close(false);
      await direct.close();
    },
  };
}
