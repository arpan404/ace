import { createServer } from "node:https";
import type { RequestListener, Server } from "node:http";
import { join } from "node:path";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import { SettingsValues } from "@ace/protocol";
import { SettingsError } from "@ace/settings";
import { remoteListener, urlHost } from "./network.ts";
import { bindListener, closeListener } from "./listener.ts";
import { startRelayTransport } from "./services/transports.ts";
import type { ServerOptions } from "./server-options.ts";
import type { RemoteAuth } from "./remote-auth.ts";

import { remotePlan, type RemotePreferences as Preferences } from "./remote-policy.ts";
const keys = ["remote.enabled", "remote.transport", "remote.relayUrl"] as const;

/** Owns network resources separately from local sessions and their event history. */
export function remoteRuntime(
  options: ServerOptions,
  auth: RemoteAuth,
  http: RequestListener,
  attach: (server: Server) => void,
  disconnect: () => void,
) {
  let listener: Server | undefined;
  let connection: { origin: string; fingerprint: string } | undefined;
  let relay: Awaited<ReturnType<typeof startRelayTransport>>;
  let preferences: Preferences = {
    "remote.enabled": false,
    "remote.transport": "local",
    "remote.relayUrl": "",
  };
  let active = "";
  let closed = false;
  let tail = Promise.resolve();
  let stop: (() => void) | undefined;
  let queued = 0;
  let reconciling = false;
  let dirty = false;
  let directTransport: "local" | "lan" | "tailscale" = "local";
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
  const retire = async () => {
    connection = undefined;
    directTransport = "local";
    disconnect();
    auth.clearPending();
    await relay?.close();
    relay = undefined;
    if (listener) await closeListener(listener);
    listener = undefined;
    active = "";
  };
  const apply = async (next: Preferences) => {
    if (closed) return;
    const config = options.remoteConfig;
    if (!config) return;
    const { listen, relayUrl, signature } = remotePlan(config, next);
    if (next["remote.enabled"] && next["remote.transport"] === "relay" && !relayUrl)
      throw new SettingsError("validation", "Enter your self-hosted relay address first.");
    if (signature === active) {
      preferences = next;
      return;
    }
    // Resolve prerequisites before taking an existing listener down. Never fall back to LAN.
    let remote;
    try {
      remote = await remoteListener({ ...config, listen }, options.network);
    } catch {
      throw new SettingsError(
        "io",
        listen === "tailscale"
          ? "Start Tailscale on this computer, then try again."
          : "Couldn't prepare encrypted LAN access. Check your network and OpenSSL installation, then try again.",
      );
    }
    const relayOptions = relayUrl
      ? { url: relayUrl, keys: await loadOrCreateHostKeys(join(config.dataDir, "relay")) }
      : undefined;
    if (closed) return;
    await retire();
    try {
      if (remote) {
        listener = createServer({ ...remote.identity, minVersion: "TLSv1.2" }, http);
        listener.requestTimeout = 10_000;
        listener.headersTimeout = 10_000;
        attach(listener);
        const port = await bindListener(listener, remote.host, remote.port);
        directTransport = listen;
        connection = {
          origin: `https://${urlHost(remote.advertisedHost)}:${port}`,
          fingerprint: remote.identity.fingerprint,
        };
      }
      if (relayOptions)
        relay = await startRelayTransport({ ...options, relay: relayOptions }, auth);
      preferences = next;
      active = signature;
    } catch {
      await retire();
      throw new SettingsError(
        "io",
        "Couldn't start remote access. Check the selected network or relay address and try again.",
      );
    }
  };
  return {
    pairing: () => connection,
    status: () => ({
      enabled: connection !== undefined || relay !== undefined,
      transport: relay ? ("relay" as const) : directTransport,
      listenOverride: options.remoteConfig?.listenOverride ? options.remoteConfig.listen : null,
      relayOverride: options.remoteConfig?.relayUrl !== undefined,
    }),
    async start() {
      if (!options.remoteConfig) return;
      if (options.settings) {
        const read = await options.settings.read({ keys: [...keys], scope: {} });
        for (const entry of read.entries) {
          if (entry.key === "remote.enabled" && typeof entry.value === "boolean")
            preferences[entry.key] = entry.value;
          if (
            entry.key === "remote.transport" &&
            ["local", "lan", "tailscale", "relay"].includes(String(entry.value))
          )
            preferences[entry.key] = SettingsValues.shape["remote.transport"].parse(entry.value);
          if (entry.key === "remote.relayUrl" && typeof entry.value === "string")
            preferences[entry.key] = entry.value;
        }
      }
      await serialize(() => apply(preferences));
      const reconcile = () => {
        dirty = true;
        if (reconciling || closed) return;
        reconciling = true;
        void serialize(async () => {
          while (dirty) {
            if (closed) break;
            dirty = false;
            const read = await options.settings?.read({ keys: [...keys], scope: {} });
            const next = { ...preferences };
            for (const entry of read?.entries ?? []) {
              if (entry.key === "remote.enabled" && typeof entry.value === "boolean")
                next[entry.key] = entry.value;
              if (entry.key === "remote.transport")
                next[entry.key] = SettingsValues.shape["remote.transport"].parse(entry.value);
              if (entry.key === "remote.relayUrl" && typeof entry.value === "string")
                next[entry.key] = entry.value;
            }
            await apply(next);
          }
        })
          .catch(() => options.log?.(new Error("Remote settings could not be applied")))
          .finally(() => {
            reconciling = false;
            if (dirty && !closed) reconcile();
          });
      };
      stop = await options.settings?.subscribe({ keys: [...keys], scope: {} }, (event) => {
        if (event.type === "changed") reconcile();
      });
    },
    get relayHostId() {
      return relay?.relayHostId;
    },
    set(key: string, value: unknown, commit: () => Promise<void>) {
      if (!keys.some((item) => item === key)) return commit();
      return serialize(async () => {
        const before = preferences;
        try {
          await apply(
            SettingsValues.pick({
              "remote.enabled": true,
              "remote.transport": true,
              "remote.relayUrl": true,
            }).parse({ ...preferences, [key]: value }),
          );
          await commit();
        } catch (failure) {
          await apply(before);
          throw failure;
        }
      });
    },
    async close() {
      closed = true;
      stop?.();
      await tail;
      await retire();
    },
  };
}
