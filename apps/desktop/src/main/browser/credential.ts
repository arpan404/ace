import { open } from "node:fs/promises";
import { join } from "node:path";
import { DeviceCredential } from "@ace/protocol";

const maxBytes = 4096;

/**
 * The desktop browser credential the daemon writes into its ACE_HOME (ADR 0055): a device
 * credential with the `desktop` scope. Missing, oversized or malformed files, or a device
 * without that scope, mean this daemon offers no embedded backend.
 */
export async function readDesktopCredential(home: string): Promise<DeviceCredential | undefined> {
  try {
    const file = await open(join(home, "browser-desktop.json"), "r");
    try {
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > maxBytes) return undefined;
      const parsed = DeviceCredential.safeParse(
        JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
      );
      return parsed.success && parsed.data.device.scopes.includes("desktop")
        ? parsed.data
        : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
