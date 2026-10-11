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

/** Notification work belongs to one endpoint/device, pinned to its authenticated host. */
export function notificationOutbox(userData: string, url: string, deviceId: string): Storage {
  const name = createHash("sha256")
    .update(JSON.stringify([url, deviceId]))
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
