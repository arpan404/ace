import { PublicToolError } from "@ace/mcp-server";
import { logFields } from "@ace/diagnostics";
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
    const failure = new PublicToolError(
      error instanceof AgentControlError || error instanceof PublicToolError
        ? error.code
        : "execution_failed",
      error instanceof PublicToolError ? error.permission : undefined,
    );
    context.log.log(
      "error",
      "Agent control tool failed",
      logFields([
        ["threadId", caller.threadId],
        ["operation", operation],
        ["code", failure.code],
        ["error", error],
        ["stack", error instanceof Error ? error.stack?.slice(0, 2048) : undefined],
        ["cause", error instanceof Error ? error.cause : undefined],
      ]),
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
              detail: failure.hint,
              text: `${failure.message}. ${failure.hint}`,
              raw: [],
            },
          },
        ],
        context.now(),
      );
    } catch (reportError) {
      context.log.log("error", "Agent control notice failed", reportError);
    }
    throw failure;
  }
}
