import { createHash } from "node:crypto";
import { z } from "zod";
import type { Item, ToolCall } from "@ace/protocol";

export function measurementTool(name: string): string | undefined {
  for (const tool of ["screen_measure_interaction", "ace_browser_measure_interaction"])
    if (name === tool || name === `mcp__ace__${tool}` || name === `ace_${tool}`) return tool;
  return undefined;
}

function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical);
  if (input !== null && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return input;
}

/** JSON object ordering differs between provider envelopes and MCP HTTP requests. */
export function argumentKey(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value ?? {})))
    .digest("hex");
}

const nativeCall = z.looseObject({
  toolName: z.string().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
  args: z.unknown().optional(),
  input: z.unknown().optional(),
});
export function measurementCall(
  item: Item,
): { name: string; key: string; call: ToolCall } | undefined {
  if (item.type !== "tool_call") return;
  const detail = item.call.detail;
  if (detail.kind === "mcp") {
    const name = measurementTool(detail.tool);
    if (name)
      return ["ace", "unknown", ""].includes(detail.server)
        ? { name, key: argumentKey(detail.arguments), call: item.call }
        : undefined;
  }
  // Generic ACP and OpenCode can report MCP tools as custom calls. Read only
  // call envelopes, never arbitrary result text or images.
  for (const raw of item.call.raw) {
    if (!("data" in raw)) continue;
    const pending: { value: unknown; depth: number }[] = [{ value: raw.data, depth: 0 }];
    while (pending.length) {
      const entry = pending.shift();
      if (!entry) break;
      const parsed = nativeCall.safeParse(entry.value);
      if (!parsed.success) continue;
      const data = parsed.data;
      const name = measurementTool(
        data.toolName ??
          data.name ??
          (typeof data["title"] === "string" ? data["title"] : undefined) ??
          (data["rawInput"] !== undefined ? item.call.title : ""),
      );
      if (name) {
        const input = data.arguments ?? data.args ?? data.input ?? data["rawInput"];
        const wrapper = z.looseObject({ args: z.unknown().optional() }).safeParse(input);
        return {
          name,
          key: argumentKey(wrapper.success ? (wrapper.data.args ?? input) : input),
          call: item.call,
        };
      }
      if (entry.depth < 4)
        for (const key of ["data", "body", "params", "update", "rawInput", "toolCall"])
          if (data[key] !== undefined) pending.push({ value: data[key], depth: entry.depth + 1 });
    }
  }
  return;
}
