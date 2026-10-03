import type { Item, ProviderKind } from "@ace/protocol";
import { z } from "zod";
const Source = z.object({
  threadId: z.string().min(1).max(512),
  provider: z.string().min(1).max(256),
  backend: z.string().min(1).max(256).optional(),
});
export interface PortableSource {
  threadId: string;
  provider: ProviderKind;
  backend?: string;
}
/** Portable ace history only. O(admitted history), with no native store or raw payload copying. */
export function portableContext(
  source: PortableSource,
  history: Iterable<Item>,
  options: { maxBytes: number; maxItems: number; historyTruncated: boolean },
): { text: string; bytes: number; truncated: boolean; source: PortableSource } {
  Source.parse(source);
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1024 ||
    options.maxBytes > 262144 ||
    !Number.isSafeInteger(options.maxItems) ||
    options.maxItems < 1 ||
    options.maxItems > 200
  )
    throw new Error("Invalid portable-context budget");
  const heading = `Context handoff from ace thread ${source.threadId}, provider ${source.provider}${source.backend ? `, backend ${source.backend}` : ""}. This is a portable summary, with loss of native state and possibly earlier content.\n`;
  const chunks = [heading];
  let bytes = Buffer.byteLength(heading);
  if (bytes + 128 > options.maxBytes)
    throw new Error("Portable source provenance exceeds context budget");
  let count = 0;
  let truncated = options.historyTruncated;
  const remaining = () => options.maxBytes - bytes - 128;
  for (const item of history) {
    if (++count > options.maxItems) {
      truncated = true;
      break;
    }
    const add = (text: string) => {
      // Check source length before encoding or constructing a large concatenation.
      if (text.length > remaining() || Buffer.byteLength(text) > remaining()) {
        truncated = true;
        return;
      }
      chunks.push(text);
      bytes += Buffer.byteLength(text);
    };
    if (item.type === "message") {
      add(`\n${item.role}: `);
      for (const part of item.parts) {
        if (part.type === "text") {
          add(part.text);
          truncated ||= part.source !== undefined;
        } else if (part.type === "file") add(`\nFile: ${part.path}\n`);
        else {
          add("\nImage omitted from context handoff.\n");
          truncated = true;
        }
      }
    } else if (item.type === "tool_call") {
      add(`\nTool ${item.call.kind}: ${item.call.title}, ${item.call.status}\n`);
      const detail = item.call.detail;
      if (detail.kind === "file.read") add(`File: ${detail.path}\n`);
      else if (detail.kind === "shell") {
        add(`Command: ${detail.command}\n`);
        if (detail.output) {
          add(detail.output.tail);
          truncated ||= detail.output.truncated;
        }
      } else if ("changes" in detail)
        for (const change of detail.changes) {
          add(`File ${change.kind}: ${change.path}\n`);
          if (change.diff) add(change.diff);
        }
    }
  }
  const footer = `\nContext truncated: ${truncated ? "yes" : "no"}. Native checkpoints and tool credentials are not transferable.\n`;
  chunks.push(footer);
  bytes += Buffer.byteLength(footer);
  return { text: chunks.join(""), bytes, truncated, source };
}
