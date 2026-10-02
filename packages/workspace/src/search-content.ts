import { normalizeLines } from "./query.ts";
import type { SafeRoot } from "./safety.ts";
import { aborted } from "./types.ts";

/** Probe in bounded chunks, then stream the same confined descriptor. */
export async function searchContent(
  safe: SafeRoot,
  path: string,
  budget: number,
  signal?: AbortSignal,
) {
  const { handle, info } = await safe.file(path);
  let scanned = 0;
  let binary = false;
  const buffer = Buffer.alloc(Math.min(64 * 1024, budget));
  try {
    while (scanned < Math.min(budget, info.size)) {
      aborted(signal);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, budget - scanned),
        scanned,
      );
      if (!bytesRead) break;
      scanned += bytesRead;
      if (buffer.subarray(0, bytesRead).includes(0)) {
        binary = true;
        break;
      }
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    bytesScanned: scanned,
    binary,
    truncated: !binary && scanned < info.size,
    close: () => handle.close(),
    async *input(): AsyncGenerator<Buffer> {
      const decoder = new TextDecoder();
      let offset = 0;
      let cr = "";
      let last = "";
      while (offset < scanned) {
        aborted(signal);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, scanned - offset),
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
        const text = cr + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        cr = text.endsWith("\r") ? "\r" : "";
        const normalized = normalizeLines(cr ? text.slice(0, -1) : text);
        if (normalized) last = normalized.slice(-1);
        yield Buffer.from(normalized);
      }
      const tail = normalizeLines(cr + decoder.decode());
      if (tail) last = tail.slice(-1);
      yield Buffer.from(tail);
      // Treat EOF and budget-cut prefixes as complete lines in both engines.
      // This delimiter does not consume physical byte budget or create an empty file's line.
      if (last && last !== "\n") yield Buffer.from("\n");
    },
  };
}
export type SearchContent = Awaited<ReturnType<typeof searchContent>>;
/** Preserve whole lines for regexes while bounding retained data to one budgeted line. */
export async function* linePackets(input: AsyncIterable<Buffer>) {
  let pending: string[] = [];
  let lineOffset = 0;
  for await (const bytes of input) {
    const chunk = bytes.toString("utf8");
    const last = chunk.lastIndexOf("\n");
    if (last >= 0) {
      const text = pending.join("") + chunk.slice(0, last + 1);
      yield { text, lineOffset };
      lineOffset += chunk.slice(0, last + 1).split("\n").length - 1;
      pending = [chunk.slice(last + 1)];
    } else pending.push(chunk);
  }
  const tail = pending.join("");
  if (tail) yield { text: tail, lineOffset };
}
