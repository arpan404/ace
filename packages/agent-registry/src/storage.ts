import { atomicJsonFile, type AtomicFileRuntime } from "./files.ts";
import type { InventoryStorage } from "./service.ts";
import type { DigestMemory } from "./inventory.ts";
export function fileInventoryStorage(
  path: string,
  id: () => string,
  runtime: AtomicFileRuntime = {},
): InventoryStorage {
  return atomicJsonFile(path, 16 * 1024 * 1024, id, runtime);
}

/** Launch digests a run settled, read back by the next one (`ExecutableDigests`). */
export function fileDigestMemory(
  path: string,
  id: () => string,
  runtime: AtomicFileRuntime = {},
): DigestMemory {
  return atomicJsonFile(path, 1024 * 1024, id, runtime);
}
