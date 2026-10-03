import { atomicJsonFile } from "./files.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { decodeIndex, limits, RegistryIndex } from "./decode.ts";
export function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export const Snapshot = z.object({
  source: z.url().max(4096),
  fetchedAt: z.number().nonnegative(),
  schemaVersion: z.string().regex(/^1\.\d+\.\d+$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  etag: z.string().max(1024).optional(),
  release: z.string().max(256).optional(),
  body: z.string().max(limits.response),
});
export type Snapshot = z.infer<typeof Snapshot>;
export function validateSnapshot(
  value: unknown,
  source: string,
): { snapshot: Snapshot; index: RegistryIndex } {
  const snapshot = Snapshot.parse(value);
  if (snapshot.source !== source || digest(snapshot.body) !== snapshot.digest)
    throw new Error("Invalid registry cache provenance");
  const index = decodeIndex(Buffer.from(snapshot.body));
  if (snapshot.schemaVersion !== index.version)
    throw new Error("Registry schema provenance mismatch");
  return { snapshot, index };
}
export interface RegistryCache {
  load(): Promise<unknown>;
  save(snapshot: Snapshot): Promise<void>;
}
export function fileCache(path: string, id: () => string): RegistryCache {
  return atomicJsonFile(path, limits.response * 2 + 65536, id);
}
export async function boundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing registry body");
  const buffer = Buffer.alloc(maximum);
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      if (bytes + part.value.byteLength > maximum) throw new Error("Response exceeds byte budget");
      buffer.set(part.value, bytes);
      bytes += part.value.byteLength;
    }
    return buffer.subarray(0, bytes);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
