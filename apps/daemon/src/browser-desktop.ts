import { open, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { DeviceCredential } from "@ace/protocol";
import type { Devices } from "./devices.ts";

/** Only the installed desktop reads this private credential, alongside the host token. */
export async function desktopCredential(
  dataDir: string,
  devices: Devices,
  now: () => number,
): Promise<void> {
  const path = join(dataDir, "browser-desktop.json");
  try {
    const file = await open(path, "r");
    let source: string;
    try {
      const bytes = Buffer.alloc(4097),
        result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 4096) throw new Error("Desktop credential exceeds limit");
      source = bytes.subarray(0, result.bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
    const credential = DeviceCredential.parse(JSON.parse(source));
    const device = devices.authenticate(credential.token, now());
    if (device?.id === credential.device.id && device.scopes.includes("desktop")) return;
  } catch {
    /* First start or revoked credential. Replace with a fresh local desktop credential. */
  }
  const credential = devices.create("ace desktop browser", ["desktop"], now());
  await writeFile(`${path}.tmp`, JSON.stringify(credential), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
