import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { fingerprint, walkFiles } from "@ace/native-session";
import type { ProviderHome } from "./contracts.ts";
export async function databaseFingerprint(path: string): Promise<string> {
  const parts = [fingerprint(await lstat(path))];
  for (const suffix of ["-wal", "-journal"]) {
    try {
      parts.push(fingerprint(await lstat(path + suffix)));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      parts.push("absent");
    }
  }
  return parts.join("|");
}
export async function storageFingerprint(
  home: ProviderHome,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(fingerprint(await lstat(path)));
  const id = basename(path, ".json");
  for await (const file of walkFiles(join(home.homeDir, "storage/message", id), signal)) {
    hash.update(file).update(fingerprint(await lstat(file)));
    for await (const part of walkFiles(
      join(home.homeDir, "storage/part", basename(file, ".json")),
      signal,
    ))
      hash.update(part).update(fingerprint(await lstat(part)));
  }
  return hash.digest("hex");
}
