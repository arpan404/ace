import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Storage } from "@ace/client";

async function read(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Notification work belongs to one daemon and device, pinned to its authenticated host. For
 * this computer's daemon the file is named after the identity its current home names, so a
 * fresh start (a new home, a new identity) starts an empty outbox instead of refusing the new
 * daemon; a remote daemon's is named after its address and stays pinned to the host it met.
 */
export function notificationOutbox(
  userData: string,
  target: { url: string; deviceId: string; localHostId?: string },
): Storage {
  const name = createHash("sha256")
    .update(
      JSON.stringify(
        target.localHostId
          ? ["local", target.localHostId, target.deviceId]
          : [target.url, target.deviceId],
      ),
    )
    .digest("hex");
  const directory = join(userData, "notification-outboxes");
  const path = join(directory, `${name}.json`);
  const save = async (file: string, value: string) => {
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, file);
  };
  return {
    load: () => read(path),
    save: (value) => save(path, value),
    hostBinding: {
      load: () => read(`${path}.host`),
      save: async (host) => {
        const previous = await read(`${path}.host`);
        if (previous !== null && previous !== host)
          throw new Error("Outbox daemon identity mismatch");
        await save(`${path}.host`, host);
      },
    },
  };
}
