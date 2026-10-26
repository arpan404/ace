import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DeviceScope } from "@ace/protocol";
import { findExecutable } from "@ace/provider-kit/discovery";
import { SettingsService } from "@ace/settings";
import { systemNetwork, type NetworkRuntime } from "../network.ts";
import type { RemotePreferences } from "../remote-policy.ts";
import type { DoctorContext } from "./feature.ts";

export type RemoteAccessPorts = {
  /** The saved remote-access settings, with environment pins applied as the daemon does. */
  preferences(context: DoctorContext): Promise<RemotePreferences>;
  /** The `tailscale` command on PATH, when installed. */
  tailscale(context: DoctorContext): Promise<string | undefined>;
  /** Network interfaces and `tailscale status --json`, as the daemon reads them. */
  network: Pick<NetworkRuntime, "interfaces" | "status">;
  /** Paired remote devices that aren't revoked; undefined when the store can't be read. */
  pairedDevices(context: DoctorContext): number | undefined;
};

export const remoteAccessPorts: RemoteAccessPorts = {
  async preferences(context) {
    const overrides = context.config.settingsOverrides;
    const settings = new SettingsService({
      dataDir: context.config.dataDir,
      ...(overrides ? { overrides } : {}),
    });
    try {
      return {
        "remote.enabled": (await settings.get("remote.enabled")).value,
        "remote.transport": (await settings.get("remote.transport")).value,
        "remote.relayUrl": (await settings.get("remote.relayUrl")).value,
      };
    } finally {
      await settings.close();
    }
  },
  tailscale: (context) => findExecutable("tailscale", context.env, context.platform),
  network: systemNetwork,
  pairedDevices: (context) => countPairedDevices(join(context.config.dataDir, "events.sqlite")),
};
// Windows looks for the installed tailscale.exe exactly as the daemon does.
if (process.platform === "win32")
  remoteAccessPorts.tailscale = async (context) =>
    (await import("../tailscale-command.ts")).findTailscaleExe(context.env);

const DeviceRow = z.object({ scopes: z.string() });
const Scopes = z.array(DeviceScope);
/** Credentials the daemon mints for its own desktop app and Chrome host; never paired. */
const localOnly = new Set<DeviceScope>(["desktop", "user-browser"]);

/** Counts paired devices in the daemon's store, opened read-only. Token hashes are never read. */
export function countPairedDevices(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 200 });
    let paired = 0;
    for (const value of db
      .prepare("SELECT scopes FROM devices WHERE revoked_at IS NULL LIMIT 1000")
      .all()) {
      const row = DeviceRow.safeParse(value);
      if (!row.success) continue;
      let scopes: z.infer<typeof Scopes>;
      try {
        const parsed = Scopes.safeParse(JSON.parse(row.data.scopes));
        if (!parsed.success) continue;
        scopes = parsed.data;
      } catch {
        continue;
      }
      if (!scopes.some((scope) => localOnly.has(scope))) paired++;
    }
    return paired;
  } catch {
    // A busy, locked or older store only costs the count; the other checks own its health.
    return undefined;
  } finally {
    db?.close();
  }
}
