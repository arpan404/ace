import type { StorageKind } from "@ace/protocol";

/** Shared by cleanup inventory and read-only usage measurement. */
export const storageFileRoots = [
  ["logs", "logs"],
  ["support/artifacts", "logs"],
  ["artifacts", "artifacts"],
  ["browser", "artifacts"],
  ["cache", "caches"],
  ["caches", "caches"],
] satisfies [string, StorageKind][];

export function excludedStoragePath(path: string): boolean {
  return (
    path === "browser/profiles" ||
    path.startsWith("browser/profiles/") ||
    path.startsWith("browser/ephemeral-")
  );
}
