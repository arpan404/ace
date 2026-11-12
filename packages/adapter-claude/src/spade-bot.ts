import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { bareToolName, dispatchedAceCall } from "@ace/provider-kit/ace-tool-names";

/** What a Spade bot's session (ADR 0133) is told when its model tries to leave plan mode. */
export const stayReadOnly =
  "This session stays read-only. Act through Spade's tools (spade_tools, spade_call) instead.";

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
