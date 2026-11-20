import type { ToolDetailDraft } from "@ace/core";
import type { ToolState } from "./state.ts";
import type { AcpQuirks } from "./quirks/types.ts";
import { completeToolRaw } from "./tool-raw.ts";
import { mcpArguments, toolDetail } from "./tools.ts";

/**
 * A tool's detail as it stands. Every path picks MCP arguments here: from the collected input
 * once the call was finalized, else from its current input.
 */
export function currentToolDetail(tool: ToolState, quirks: AcpQuirks): ToolDetailDraft {
  const detail = toolDetail(tool.data, quirks);
  if (detail.kind === "mcp" && tool.completedInput)
    detail.arguments = mcpArguments(tool.completedInput);
  return detail;
}

/** All terminal paths publish the same collected input in raw and typed MCP arguments. */
export function finalizeTool(tool: ToolState, quirks: AcpQuirks): ToolDetailDraft {
  completeToolRaw(tool);
  return currentToolDetail(tool, quirks);
}
