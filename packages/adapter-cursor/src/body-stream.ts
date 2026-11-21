import { createHash } from "node:crypto";
import { boundedJson, jsonPieces } from "@ace/provider-kit/ipc";
import { createStreamingRedactor, isSensitiveField, type RedactionContext } from "@ace/redaction";
import { z } from "zod";
import { object } from "./contracts.ts";
import { ShellStreams } from "./shell-streams.ts";
import { streamText, markText } from "./text-stream.ts";
import { sdkImages } from "./sdk-images.ts";

export const BlobPart = z.object({
  id: z.string().regex(/^sdk-raw-[a-f0-9]{64}$/),
  offset: z.number().int().nonnegative(),
  text: z.string().max(65536).optional(),
  done: z.boolean().optional(),
});
export const BlobReference = z.object({
  type: z.literal("cursor.sdk.body"),
  blobRef: BlobPart.shape.id,
  size: z.number().int().nonnegative().max(16777216),
  preview: z.string().max(2048),
});
const omitted = Symbol("omitted");
/** SDK raw provenance and canonical output share the existing engine storage owners. */
export async function streamSdkBody(
  body: unknown,
  identity: string,
  emit: (kind: string, body: unknown) => Promise<void>,
  context: RedactionContext,
  maxBytes = 16777216,
  shell = new ShellStreams(),
  scope = identity,
  frameBytes = 262144,
): Promise<{ body: unknown; raw?: z.infer<typeof BlobReference> }> {
  body = sdkImages(body, maxBytes);
  const scrub = createStreamingRedactor(context);
  const text = (value: string, field?: string) =>
    isSensitiveField(field ?? "", value) ? ["<SECRET>"] : scrub(value);
  let safe: unknown;
  try {
    safe = JSON.parse(boundedJson(body, Math.min(60000, frameBytes - 2048)));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const id = `sdk-raw-${createHash("sha256").update(identity).digest("hex")}`;
    let offset = 0,
      preview = "",
      pending = "",
      pendingBytes = 0;
    const flush = async () => {
      if (!pending) return;
      await emit("blob", { id, offset, text: pending });
      offset += Buffer.byteLength(pending);
      if (preview.length < 512) preview += pending.slice(0, 512 - preview.length);
      pending = "";
      pendingBytes = 0;
    };
    for (const piece of jsonPieces(body, text, maxBytes, isSensitiveField)) {
      if (
        pendingBytes + Buffer.byteLength(piece) >
        Math.min(60000, Math.floor((frameBytes - 2048) / 4))
      )
        await flush();
      // Even one escaped string fragment may exceed a small injected frame cap.
      const chunkChars = Math.max(64, Math.floor((frameBytes - 2048) / 24));
      for (let position = 0; position < piece.length;) {
        let end = Math.min(piece.length, position + chunkChars);
        const high = piece.charCodeAt(end - 1),
          low = piece.charCodeAt(end);
        if (
          end < piece.length &&
          high >= 0xd800 &&
          high <= 0xdbff &&
          low >= 0xdc00 &&
          low <= 0xdfff
        )
          end++;
        const chunk = piece.slice(position, end),
          bytes = Buffer.byteLength(chunk);
        position = end;
        if (pendingBytes + bytes > Math.min(60000, Math.floor((frameBytes - 2048) / 4)))
          await flush();
        pending += chunk;
        pendingBytes += bytes;
      }
    }
    await flush();
    await emit("blob", { id, offset, done: true });
    // Bounded semantic preview. Full opaque strings stay in the streamed raw blob, so a
    // wide body is summarised up to a byte budget and marked, never refused.
    let nodes = 0,
      used = 0,
      truncated = false;
    const budget = Math.min(262144, frameBytes - 2048) - 1024;
    const fits = (bytes: number) => {
      if (used + bytes > budget) truncated = true;
      else used += bytes;
      return !truncated;
    };
    const previewValue = (value: unknown, depth: number, field?: string): unknown => {
      if (++nodes > 32768 || depth > 64)
        throw new Error("SDK preview structure exceeds budget", { cause: error });
      if (isSensitiveField(field ?? "", value)) return fits(10) ? "<SECRET>" : omitted;
      if (typeof value === "string") {
        const clipped = (scrub(value)[Symbol.iterator]().next().value ?? "").slice(0, 512);
        return fits(Buffer.byteLength(JSON.stringify(clipped))) ? clipped : omitted;
      }
      if (
        value === null ||
        value === undefined ||
        typeof value === "boolean" ||
        typeof value === "number"
      )
        return fits(JSON.stringify(value ?? null).length) ? value : omitted;
      if (typeof value !== "object") throw new Error("SDK preview is not JSON", { cause: error });
      if (!fits(2)) return omitted;
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (const item of value.slice(0, 128)) {
          if (!fits(1)) break;
          const summary = previewValue(item, depth + 1);
          if (summary === omitted) break;
          items.push(summary);
        }
        return items;
      }
      const result: Record<string, unknown> = {};
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
          throw new Error("SDK getter rejected", { cause: error });
        if (truncated || !fits(Buffer.byteLength(JSON.stringify(key)) + 2)) break;
        const summary = previewValue(descriptor.value, depth + 1, key);
        if (summary === omitted) break;
        Object.defineProperty(result, key, { value: summary, enumerable: true });
      }
      return result;
    };
    safe = previewValue(body, 0);
    if (safe === omitted) safe = null;
    if (truncated && safe !== null && typeof safe === "object" && !Array.isArray(safe))
      safe = { ...safe, acePreviewTruncated: true };
    const output = await shell.stream(
      body,
      scope,
      emit,
      scrub,
      Math.max(128, Math.floor((frameBytes - 2048) / 6)),
    );
    return {
      body: markText(markOutput(safe, output), await streamText(body, emit, scrub, frameBytes)),
      raw: BlobReference.parse({ type: "cursor.sdk.body", blobRef: id, size: offset, preview }),
    };
  }
  const output = await shell.stream(
    body,
    scope,
    emit,
    scrub,
    Math.max(128, Math.floor((frameBytes - 2048) / 6)),
  );
  return { body: markOutput(safe, output) };
}
function markOutput(safe: unknown, output: unknown): unknown {
  const marked = object(output),
    preview = object(safe);
  if (marked.aceOutputStream === true) return { ...preview, aceOutputStream: true };
  if (object(marked.taskUpdate).aceOutputStream === true)
    return { ...preview, taskUpdate: { ...object(preview.taskUpdate), aceOutputStream: true } };
  return safe;
}
