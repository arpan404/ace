/** Persistent storage boundary for isolated-worker tests. Every path lives under a temp root. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Storage } from "@ace/client";

const key = (value: string) => createHash("sha256").update(value).digest("hex");
export function machineOutbox(root: string, hostId: string, deviceId: string): Storage {
  const directory = join(root, key(JSON.stringify([hostId, deviceId])));
  return {
    records: {
      async load() {
        await mkdir(directory, { recursive: true });
        return Promise.all(
          (await readdir(directory)).map((file) => readFile(join(directory, file), "utf8")),
        );
      },
      async write(id, value) {
        const path = join(directory, key(id));
        if (value === null) await rm(path, { force: true });
        else await writeFile(path, value);
      },
    },
    async load() {
      throw new Error("The worker must use record storage");
    },
    async save() {
      throw new Error("The worker must use record storage");
    },
  };
}
