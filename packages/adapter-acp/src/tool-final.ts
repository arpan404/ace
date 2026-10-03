import type { ToolDetailDraft } from "@ace/core";
import type { ToolState } from "./state.ts";
import type { AcpQuirks } from "./quirks/types.ts";
import { completeToolRaw } from "./tool-raw.ts";
import { toolDetail } from "./tools.ts";

/** All terminal paths publish the same collected input in raw and typed MCP arguments. */
export function finalizeTool(tool: ToolState, quirks: AcpQuirks): ToolDetailDraft {
  const input = completeToolRaw(tool);
  const detail = toolDetail(tool.data, quirks);
  if (detail.kind === "mcp" && input) detail.arguments = input["args"] ?? input;
  return detail;
}
