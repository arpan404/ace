import type { ToolCall } from "@ace/protocol";

/** ace's own smoothness tools, as an MCP server names them. */
const tools = new Set(["screen_measure_interaction", "ace_browser_measure_interaction"]);

/**
 * Whether a step is one of ace's interaction measurements, which the work log shows as a
 * smoothness card rather than a generic tool row. Only ace's own server counts.
 */
export function isMeasurementCall(call: Pick<ToolCall, "detail">): boolean {
  const { detail } = call;
  return detail.kind === "mcp" && /^ace$|^ace[-_]/.test(detail.server) && tools.has(detail.tool);
}
