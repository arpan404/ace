import type { Config } from "./config.ts";
import type { SettingsValues } from "@ace/protocol";

export type RemotePreferences = Pick<
  SettingsValues,
  "remote.enabled" | "remote.transport" | "remote.relayUrl"
>;

/** Launch overrides independently pin direct listening and the optional outbound relay. */
export function remotePlan(config: Config, preferences: RemotePreferences) {
  const enabled = preferences["remote.enabled"];
  const transport = preferences["remote.transport"];
  const listenOverride = config.listenOverride ?? config.listen !== "local";
  const listen = listenOverride
    ? config.listen
    : !enabled
      ? "local"
      : transport === "tailscale"
        ? "tailscale"
        : "lan";
  const relayUrl = config.relayUrl ?? (enabled ? preferences["remote.relayUrl"] : "");
  return { listen, relayUrl, signature: JSON.stringify([listen, relayUrl]) };
}
