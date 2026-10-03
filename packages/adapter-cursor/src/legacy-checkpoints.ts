import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

/** SDK JSONL readers ignore torn final records; ace refuses that lossy continuation. */
export async function validateLegacyCheckpoint(path: string, maxBytes: number): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error(
        "Unsafe or oversized SDK JSONL checkpoint; preserve source and use context handoff",
      );
    const stream = file.createReadStream({ autoClose: false, highWaterMark: 4096 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let bytes = 0;
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > maxBytes) throw new Error("SDK JSONL checkpoint exceeds budget");
        // No parse result crosses into ace history; the SDK remains its format owner.
        JSON.parse(line);
      }
      if (bytes !== stat.size)
        throw new Error("SDK JSONL checkpoint has an incomplete final commit");
    } catch {
      throw new Error(
        "SDK JSONL checkpoint is incomplete or malformed; preserve source and use context handoff",
      );
    } finally {
      lines.close();
      stream.destroy();
    }
  } finally {
    await file.close();
  }
}
