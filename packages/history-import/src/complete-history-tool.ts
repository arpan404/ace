import { Item, type RawPayload } from "@ace/protocol";
import { outputStreamId, summarizeOutput } from "@ace/projection";
import type { Completion } from "./native-tools.ts";
import type { Packet } from "./contracts.ts";

type ToolItem = Extract<Item, { type: "tool_call" }>;
/** One completion at a time, even when a native record contains thousands of calls. */
export function* completeHistoryTool(
  item: ToolItem,
  result: Completion,
): Generator<Packet, ToolItem> {
  const streamId = outputStreamId(item.id);
  const output = Buffer.from(result.text);
  yield { type: "blob.start", id: streamId, bytes: output.length };
  for (let offset = 0; offset < output.length; offset += 64 * 1024)
    yield {
      type: "blob.chunk",
      id: streamId,
      bytes: Uint8Array.from(output.subarray(offset, offset + 64 * 1024)),
    };
  yield { type: "blob.end", id: streamId };
  const bytes = Buffer.from(JSON.stringify(result.value));
  let raw: RawPayload = { type: "history.tool_result", data: result.value };
  if (bytes.length > 64 * 1024) {
    const id = `${streamId}:raw`;
    yield { type: "blob.start", id, bytes: bytes.length };
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
      yield {
        type: "blob.chunk",
        id,
        bytes: Uint8Array.from(bytes.subarray(offset, offset + 64 * 1024)),
      };
    yield { type: "blob.end", id };
    raw = { type: "history.tool_result", blobRef: id, size: bytes.length, preview: "" };
  }
  const detail = item.call.detail;
  const parsed = Item.parse({
    ...item,
    call: {
      ...item.call,
      status: result.failed ? "failed" : "succeeded",
      endedAt: Math.max(item.call.startedAt, result.at ?? item.createdAt),
      detail:
        detail.kind === "shell"
          ? {
              ...detail,
              output: summarizeOutput(item.id, result.text),
            }
          : detail,
      raw: [
        ...item.call.raw,
        raw,
        ...(detail.kind === "shell"
          ? []
          : [{ type: "history.output", blobRef: streamId, size: output.length, preview: "" }]),
      ],
    },
  });
  if (parsed.type !== "tool_call") throw new Error("Invalid completed history call");
  return parsed;
}
