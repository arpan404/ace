import type { z } from "zod";
import { parseToolArguments } from "./tool-failure.ts";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { withinJsonBudget, ResultBudgetExceeded } from "./json-budget.ts";
import type { ToolContext } from "./registry.ts";
import type { McpCapability } from "@ace/protocol";
import { maxRichResultBytes } from "./result-budgets.ts";
export interface ContentToolDefinition<I extends z.ZodType> {
  name: string;
  riskClass?: import("@ace/protocol").ApprovalTarget["riskClass"];
  destructive?: boolean;
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
  const args = parseToolArguments(definition.input, input);
  context.signal.throwIfAborted();
  const result = await definition.run(args, context);
  const limit = maxRichResultBytes;
  if (!withinJsonBudget(result, limit)) throw new ResultBudgetExceeded();
  const { specTypeSchemas } = await import("@modelcontextprotocol/server");
  const checked = specTypeSchemas.CallToolResult["~standard"].validate(result);
  if (checked.issues) throw new Error("Invalid MCP tool content");
  if (Buffer.byteLength(JSON.stringify(checked.value)) > limit) throw new ResultBudgetExceeded();
  return checked.value;
}
