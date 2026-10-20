import { PublicToolError } from "@ace/mcp-server";
import { logError } from "@ace/diagnostics";
import { logToolFailure } from "../tool-failure-log.ts";
import { ItemId, type McpAttribution } from "@ace/protocol";
import { AgentControlError } from "../agent-control/failure.ts";
import type { ServiceContext } from "./types.ts";

/** One reporting boundary for modern controls and the legacy spawn tool. */
export async function agentControlCall<T>(
  context: ServiceContext,
  caller: McpAttribution,
  operation: string,
  signal: AbortSignal,
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (signal.aborted) throw error;
    const code =
      error instanceof AgentControlError || error instanceof PublicToolError
        ? error.code
        : "execution_failed";
    const errorId = logToolFailure(context.log, context.id, {
      tool: operation,
      caller,
      error,
      code,
    });
    const failure = new PublicToolError(
      code,
      error instanceof PublicToolError ? error.permission : undefined,
      undefined,
      undefined,
      error instanceof AgentControlError ? error.publicDetail : undefined,
      undefined,
      errorId,
    );
    // Reporting cannot replace the original failure, including during shutdown.
    try {
      context.store.appendEvents(
        caller.threadId,
        [
          {
            type: "item.created",
            item: {
              id: ItemId.parse(context.id()),
              agentId: caller.agentId,
              createdAt: context.now(),
              type: "notice",
              level: "error",
              complete: true,
              code: failure.code,
              title: failure.message,
              // One short reason: what the agent was told it can retry with, else the hint.
              text: failure.detail ?? failure.hint,
              raw: [
                {
                  type: "ace.agent_control.failed",
                  data: { operation, ...(errorId ? { errorId } : {}) },
                },
              ],
            },
          },
        ],
        context.now(),
      );
    } catch (reportError) {
      context.log.log("error", "Agent control notice failed", logError(reportError));
    }
    throw failure;
  }
}
