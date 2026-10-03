import { createHash } from "node:crypto";
import { boundedJson, jsonPieces } from "@ace/provider-kit/ipc";
import { createStreamingRedactor, isSensitiveField, type RedactionContext } from "@ace/redaction";
import { z } from "zod";
import { object, string } from "./contracts.ts";
import { ShellStreams } from "./shell-streams.ts";

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
    // Bounded semantic preview. Full opaque strings stay in the streamed raw blob.
    let nodes = 0;
    const previewValue = (value: unknown, depth: number, field?: string): unknown => {
      if (++nodes > 32768 || depth > 64)
        throw new Error("SDK preview structure exceeds budget", { cause: error });
      if (isSensitiveField(field ?? "", value)) return "<SECRET>";
      if (typeof value === "string")
        return (scrub(value)[Symbol.iterator]().next().value ?? "").slice(0, 512);
      if (
        value === null ||
        value === undefined ||
        typeof value === "boolean" ||
        typeof value === "number"
      )
        return value;
      if (typeof value !== "object") throw new Error("SDK preview is not JSON", { cause: error });
      if (Array.isArray(value))
        return value.slice(0, 128).map((item) => previewValue(item, depth + 1));
      const result: Record<string, unknown> = {};
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
          throw new Error("SDK getter rejected", { cause: error });
        Object.defineProperty(result, key, {
          value: previewValue(descriptor.value, depth + 1, key),
          enumerable: true,
        });
      }
      return result;
    };
    safe = previewValue(body, 0);
    boundedJson(safe, 262144);
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

async function streamText(
  body: unknown,
  emit: (kind: string, body: unknown) => Promise<void>,
  scrub: (text: string) => Iterable<string>,
  frameBytes: number,
): Promise<boolean> {
  const update = object(body),
    text = string(update.text);
  if (!["text-delta", "thinking-delta"].includes(string(update.type) ?? "") || !text) return false;
  const chars = Math.max(128, Math.floor((frameBytes - 2048) / 6));
  for (const piece of scrub(text))
    for (let offset = 0; offset < piece.length;) {
      let end = Math.min(piece.length, offset + chars);
      const high = piece.charCodeAt(end - 1),
        low = piece.charCodeAt(end);
      if (end < piece.length && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff)
        end++;
      await emit("delta-chunk", { type: update.type, text: piece.slice(offset, end) });
      offset = end;
    }
  return true;
}
function markText(body: unknown, streamed: boolean): unknown {
  return streamed ? { ...object(body), aceTextStream: true } : body;
}
