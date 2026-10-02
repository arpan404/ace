import { object, string, timestamp } from "@ace/native-session";
import type { HistoryProvider } from "@ace/protocol/history";
import { z } from "zod";

export const Completion = z.object({
  id: z.string(),
  text: z.string(),
  failed: z.boolean(),
  at: z.number().optional(),
  value: z.unknown(),
});
export type Completion = z.infer<typeof Completion>;
export function nativeCompletions(value: unknown, provider: HistoryProvider): Completion[] {
  const r = object(value),
    p = provider === "codex" ? object(r.payload) : r;
  const blocks = provider === "claude" ? object(r.message).content : [p];
  if (!Array.isArray(blocks)) return [];
  const results: Completion[] = [];
  for (const valueBlock of blocks) {
    const b = object(valueBlock);
    const id = string(b.call_id) ?? string(b.tool_use_id);
    if (
      !id ||
      !["function_call_output", "custom_tool_call_output", "tool_result"].includes(String(b.type))
    )
      continue;
    const output = b.output ?? b.content;
    const text =
      typeof output === "string"
        ? output
        : Array.isArray(output)
          ? output.map((part) => string(object(part).text) ?? "").join("\n")
          : "";
    results.push({
      id,
      text,
      failed: b.is_error === true,
      at: timestamp(r.timestamp),
      value: valueBlock,
    });
  }
  return results;
}
export function nativeCallId(block: Record<string, unknown>): string | undefined {
  return string(block.call_id) ?? string(block.id);
}
