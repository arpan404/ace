import { join, basename } from "node:path";
import { lstat } from "node:fs/promises";
import { fingerprint, object, string, readJsonLines } from "@ace/native-session";
import type { Catalog } from "./catalog.ts";
import type { ProviderHome } from "./contracts.ts";
import { sessionTitle } from "./user-text.ts";

export async function scanCodexTitles(
  catalog: Catalog,
  instance: ProviderHome,
  epoch: number,
  signal: AbortSignal,
) {
  const path = join(instance.homeDir, "session_index.jsonl");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const fp = fingerprint(info);
  if (catalog.touch(instance.id, path, fp, epoch)) return;
  let count = 0;
  for await (const record of readJsonLines(instance.homeDir, path, signal)) {
    signal.throwIfAborted();
    if (++count > 100000) throw new Error("Session title inventory limit exceeded");
    if (!("value" in record)) continue;
    const r = object(record.value);
    const id = string(r.id),
      title = string(r.thread_name);
    if (id && title && id.length <= 1024)
      catalog.setNativeTitle(instance.id, id, sessionTitle(title, "", info.mtimeMs), "index");
  }
  if (fingerprint(await lstat(path)) !== fp)
    throw new Error(`${basename(path)} changed while reading titles`);
  catalog.remember(instance, path, info.size, info.mtimeMs, fp, epoch);
}
