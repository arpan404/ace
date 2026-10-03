import { atomicJsonFile } from "./files.ts";
import type { InventoryStorage } from "./service.ts";
export function fileInventoryStorage(path: string, id: () => string): InventoryStorage {
  return atomicJsonFile(path, 16 * 1024 * 1024, id);
}
