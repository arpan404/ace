import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { withinJsonBudget, ResultBudgetExceeded } from "./json-budget.ts";
import type { ToolContext } from "./registry.ts";
import type { McpCapability } from "@ace/protocol";
export interface ContentToolDefinition<I extends z.ZodType> {
  name: string;
  riskClass?: import("@ace/protocol").ApprovalTarget["riskClass"];
  description: string;
  input: I;
  capability: McpCapability;
  timeoutMs: number;
  run(input: z.output<I>, context: ToolContext): Promise<unknown>;
}
/** Rich results have a separate bounded API, so structured tools keep their 256 KiB cap. */
export async function executeContent<I extends z.ZodType>(
  definition: ContentToolDefinition<I>,
  input: unknown,
  context: ToolContext,
): Promise<CallToolResult> {
  if (!withinJsonBudget(input, 64 * 1024)) throw new Error("Input budget exceeded");
  const args = definition.input.parse(input);
  context.signal.throwIfAborted();
  const result = await definition.run(args, context);
  const limit = 12 * 1024 * 1024; // Includes base64 expansion of the 8 MiB JPEG limit.
  if (!withinJsonBudget(result, limit)) throw new ResultBudgetExceeded();
  const { specTypeSchemas } = await import("@modelcontextprotocol/server");
  const checked = specTypeSchemas.CallToolResult["~standard"].validate(result);
  if (checked.issues) throw new Error("Invalid MCP tool content");
  if (Buffer.byteLength(JSON.stringify(checked.value)) > limit) throw new ResultBudgetExceeded();
  return checked.value;
}
