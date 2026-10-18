import { createHash } from "node:crypto";
import { aceToolInput } from "@ace/core";
import type { Item, ToolCall } from "@ace/protocol";
import { bareToolName } from "@ace/provider-kit/ace-tool-names";

/** The bare name of a measuring tool, from any spelling of ace's tool name. */
export function measurementTool(name: string): string | undefined {
  const tool = bareToolName(name);
  return tool === "screen_measure" || tool === "browser_measure" ? tool : undefined;
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

export function measurementCall(
  item: Item,
): { name: string; key: string; call: ToolCall } | undefined {
  if (item.type !== "tool_call") return;
  const tool = aceToolInput(item.call);
  const name = tool && measurementTool(tool.name);
  return tool && name ? { name, key: argumentKey(tool.input), call: item.call } : undefined;
}
