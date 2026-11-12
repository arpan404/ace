import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { bareToolName, dispatchedAceCall } from "@ace/provider-kit/ace-tool-names";

/** What a Spade bot's session (ADR 0133) is told when its model tries to leave plan mode. */
export const stayReadOnly =
  "This session stays read-only and has no plan to approve: don't call ExitPlanMode again. Your " +
  "plan was delivered to the person as your reply. Act through Spade's tools (spade_tools, " +
  "spade_call), and write any further answer as your reply message.";

/**
 * The text Claude put in a refused `ExitPlanMode` (in plan mode its answer often lives there),
 * as an assistant message of the session, so the person still gets it as the bot's reply.
 * Undefined when the call carries no plan.
 */
export function refusedPlanMessage(
  toolName: string,
  input: Record<string, unknown>,
  id: string,
): Record<string, unknown> | undefined {
  if (toolName !== "ExitPlanMode") return undefined;
  const plan = typeof input["plan"] === "string" ? input["plan"].trim() : "";
  if (!plan) return undefined;
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: `spade-plan-${id}`, role: "assistant", content: [{ type: "text", text: plan }] },
  };
}

/**
 * How a Spade bot's hidden session answers Claude's permission check without a prompt nobody
 * would see: ace tools on its allow list (Spade's gated bridge, ace's reads) run, called
 * directly or through `tools_call`; leaving plan mode is refused with a message. Undefined
 * leaves the check to the usual interaction.
 */
export function spadeBotPermission(
  allowAceTools: readonly string[],
  toolName: string,
  input: Record<string, unknown>,
): PermissionResult | undefined {
  if (toolName === "ExitPlanMode") return { behavior: "deny", message: stayReadOnly };
  if (!toolName.startsWith("mcp__ace__")) return undefined;
  const target = dispatchedAceCall(bareToolName(toolName), input);
  return allowAceTools.includes(bareToolName(target.name))
    ? { behavior: "allow", updatedInput: input }
    : undefined;
}
