import { open } from "node:fs/promises";
import { join } from "node:path";
import { DesktopCredential } from "./protocol.ts";

const maxBytes = 4096;

/**
 * The desktop browser credential the daemon writes into its ACE_HOME (ADR 0055). Missing,
 * oversized or malformed files mean this daemon offers no embedded backend.
 */
export async function readDesktopCredential(home: string): Promise<DesktopCredential | undefined> {
  try {
    const file = await open(join(home, "browser-desktop.json"), "r");
    try {
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > maxBytes) return undefined;
      const parsed = DesktopCredential.safeParse(
        JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
      );
      return parsed.success ? parsed.data : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
