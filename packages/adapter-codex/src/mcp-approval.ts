import { z } from "zod";
import { ApprovalTarget, type ApprovalOption, type InteractionRequest } from "@ace/protocol";
import type { InteractionResolution } from "@ace/protocol";

/*
 * Codex asks before an MCP tool call with an `mcpServer/elicitation/request` whose `_meta` names
 * it an MCP tool approval and lists the scopes it can remember (`persist`). It is a yes/no
 * approval, not a form: ace shows it as one, so the person can allow the tool for the rest of
 * the thread, and ace's own consent review sees which tool of which server is asking.
 */

const Persist = z.union([z.enum(["session", "always"]), z.array(z.string()).max(8)]);
const ToolApproval = z
  .object({
    serverName: z.string().min(1).max(256),
    message: z.string().max(8192),
    _meta: z
      .object({
        codex_approval_kind: z.literal("mcp_tool_call"),
        persist: Persist.optional(),
        tool_name: z.string().min(1).max(256).optional(),
        tool_title: z.string().max(1024).optional(),
        tool_params: z.unknown().optional(),
      })
      .passthrough(),
  })
  .transform((value) => ({ ...value, meta: value["_meta"] }));

/** The tool a Codex MCP approval is for: its metadata, else the name quoted in its message. */
function toolName(approval: z.infer<typeof ToolApproval>): string | undefined {
  return approval.meta.tool_name ?? /run tool "([^"]{1,256})"/.exec(approval.message)?.[1];
}

/**
 * A Codex MCP tool approval as an ace approval request; anything else stays an elicitation.
 * "Always" is never offered: Codex would write it into the person's own config.toml for a
 * server entry that only exists in ace's per-thread configuration.
 */
export function mcpToolApproval(
  params: unknown,
): Extract<InteractionRequest, { kind: "approval" }> | undefined {
  const parsed = ToolApproval.safeParse(params);
  if (!parsed.success) return undefined;
  const approval = parsed.data;
  const persist = approval.meta.persist;
  const scopes = new Set(typeof persist === "string" ? [persist] : (persist ?? []));
  const tool = toolName(approval);
  const target = tool
    ? ApprovalTarget.safeParse({ tool, access: "unknown", input: approval.meta.tool_params })
    : undefined;
  const options: ApprovalOption[] = [
    { id: "accept", label: "Allow once", kind: "allow_once" },
    ...(scopes.has("session")
      ? [{ id: "accept_session", label: "Allow for this thread", kind: "allow_session" as const }]
      : []),
    { id: "decline", label: "Deny", kind: "deny" },
    { id: "cancel", label: "Cancel", kind: "cancel" },
  ];
  return {
    kind: "approval",
    title: approval.meta.tool_title ?? tool ?? approval.message,
    description: approval.message,
    ...(target?.success ? { target: target.data } : {}),
    options,
    mcpServer: { name: approval.serverName, source: "codex" },
  };
}

/** The elicitation answer for an approval option; a remembered scope rides in `_meta.persist`. */
export function mcpToolApprovalResult(
  resolution: Extract<InteractionResolution, { kind: "approval" }>,
): { action: "accept" | "decline" | "cancel"; _meta?: { persist: "session" } } {
  switch (resolution.optionId) {
    case "accept":
      return { action: "accept" };
    case "accept_session":
      return { action: "accept", _meta: { persist: "session" } };
    case "decline":
      return { action: "decline" };
    case "cancel":
      return { action: "cancel" };
    default:
      throw new Error("Approval option is not offered by Codex");
  }
}
