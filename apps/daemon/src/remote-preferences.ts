// SPDX-License-Identifier: Apache-2.0
import { SettingsValues } from "@ace/protocol";
import { transportNetworks } from "@ace/settings";
import { defaults } from "@ace/settings/defaults";
import { remotePreferenceKeys, type RemotePreferences } from "./remote-policy.ts";
import type { ServerOptions } from "./server-options.ts";

export const StoredRemotePreferences = SettingsValues.pick({
  "remote.enabled": true,
  "remote.lan": true,
  "remote.tailscale": true,
  "remote.relay": true,
  "remote.relayUrl": true,
});

/** The networks and the older single choice the runtime still accepts. */
export const remoteSettingKeys = [...remotePreferenceKeys, "remote.transport"] as const;

export const defaultRemotePreferences = (): RemotePreferences =>
  StoredRemotePreferences.parse(defaults);

export async function readRemotePreferences(
  settings: ServerOptions["settings"],
  base: RemotePreferences,
): Promise<RemotePreferences> {
  const entries = (await settings?.read({ keys: [...remotePreferenceKeys], scope: {} }))?.entries;
  const next: Record<string, unknown> = { ...base };
  for (const entry of entries ?? []) next[entry.key] = entry.value;
  const parsed = StoredRemotePreferences.safeParse(next);
  return parsed.success ? parsed.data : base;
}

/** Translate the older single-network setting before applying the new preferences. */
export function remotePreferenceChange(
  base: RemotePreferences,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return key === "remote.transport"
    ? transportNetworks(
        SettingsValues.shape["remote.transport"].parse(value),
        base["remote.relayUrl"],
      )
    : { [key]: value };
}
