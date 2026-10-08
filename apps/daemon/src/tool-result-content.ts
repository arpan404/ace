import { createHash } from "node:crypto";
import { z } from "zod";
import { ToolResult, type McpAttribution } from "@ace/protocol";
import type { ContextService } from "@ace/context";
import { privateAceInput } from "@ace/core";
const imageSchema = z.object({
  type: z.literal("image"),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z
    .string()
    .max(11_184_812)
    .regex(/^[a-zA-Z0-9+/]*={0,2}$/),
});
const envelope = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.unknown()),
  structuredContent: z.unknown().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const textSchema = z.object({ type: z.literal("text"), text: z.string() });
const metadata = ToolResult.pick({ target: true, mode: true, scale: true, size: true });

function boundedText(text: string, bytes: number): string {
  const encoded = Buffer.from(text.slice(0, bytes));
  let end = Math.min(encoded.length, bytes);
  while (end > 0) {
    const byte = encoded[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return encoded.subarray(0, end).toString("utf8");
}

/** Same chunked upload API used by incoming thread attachments. */
export async function toolImage(
  context: ContextService,
  caller: McpAttribution,
  image: z.infer<typeof imageSchema>,
) {
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Tool image exceeds limit");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const device = "daemon-tool-result";
  const begin = await context.uploads.handle(device, {
    op: "upload.begin",
    threadId: caller.threadId,
    sha256,
    bytes: bytes.length,
    name: `ace-tool-result.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]}`,
    mimeType: image.mimeType,
  });
  if (begin.kind !== "upload") throw new Error("Tool image upload refused");
  try {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
      await context.uploads.handle(device, {
        op: "upload.chunk",
        uploadId: begin.uploadId,
        offset,
        data: bytes.subarray(offset, offset + 64 * 1024).toString("base64"),
      });
    const committed = await context.uploads.handle(device, {
      op: "upload.commit",
      uploadId: begin.uploadId,
    });
    if (committed.kind !== "attachment") throw new Error("Tool image commit refused");
    return committed.attachment;
  } catch (error) {
    await context.uploads.handle(device, { op: "upload.cancel", uploadId: begin.uploadId });
    throw error;
  }
}

export async function captureToolResult(
  name: string,
  value: unknown,
  input: unknown,
  durationMs: number,
  caller: McpAttribution,
  context: ContextService | undefined,
): Promise<ToolResult> {
  const result = envelope.parse(value);
  const content: ToolResult["content"] = [];
  let textRemaining = 32_768;
  let imageBytes = 0;
  const privateInput = privateAceInput(name, input);
  for (const block of result.content.slice(0, 16)) {
    const text = textSchema.safeParse(block);
    if (text.success) {
      const rendered =
        privateInput && !result.isError ? "[redacted]" : boundedText(text.data.text, textRemaining);
      textRemaining -= Buffer.byteLength(rendered);
      if (rendered) content.push({ type: "text", text: rendered });
      continue;
    }
    const image = imageSchema.safeParse(block);
    if (!image.success || !context || privateInput) continue;
    imageBytes += image.data.data.length;
    if (imageBytes > 11_184_812) continue;
    try {
      content.push({ type: "image", attachment: await toolImage(context, caller, image.data) });
    } catch {
      content.push({ type: "text", text: "Image attachment unavailable" });
    }
  }
  let structuredContent = privateInput ? undefined : result.structuredContent;
  if (structuredContent === undefined && !privateInput) {
    const first = content.find((part) => part.type === "text");
    if (first?.type === "text") {
      try {
        const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(first.text));
        if (parsed.success) structuredContent = parsed.data;
      } catch {
        /* Plain text results remain text. */
      }
    }
  }
  if (
    structuredContent !== undefined &&
    Buffer.byteLength(JSON.stringify(structuredContent)) > 32_768
  )
    structuredContent = undefined;
  const checked = metadata.safeParse(result["_meta"]?.["ace/screen"]);
  return ToolResult.parse({
    isError: result.isError ?? false,
    content,
    durationMs,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(checked.success ? checked.data : {}),
  });
}
