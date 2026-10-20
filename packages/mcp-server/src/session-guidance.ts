import type { ProviderKind } from "@ace/protocol";
import { aceGuidance } from "./status.ts";
import { codexPrefix } from "./codex-guidance.ts";

/** Providers whose CLI shows MCP server instructions to the model; the rest opt out. */
const readsServerInstructions = new Set<ProviderKind>(["claude", "opencode", "acp", "antigravity"]);
/** What the daemon knows about this session when it injects guidance. */
export interface SessionGuidance {
  /** The session brief (facts), rendered by `renderBrief`. */
  brief?: string | undefined;
  /** Enabled ace groups. Omitted: guidance for every group. */
  groups?: readonly string[] | undefined;
  /** The person's roles at session start, rendered by `renderRoles`; absent when none is set. */
  roles?: string | undefined;
  /** Bare names of the ace tools this session can call, for clients that never see them. */
  tools?: readonly string[] | undefined;
}
/** Where the provider natively lists ace's shipped skills; the rest read them via `guide`. */
const skills = "The ace guides except offshift are also installed as skills.";
/** How each provider spells ace's bare tool names (its MCP namespace for server `ace`). */
const prefix: Record<ProviderKind, (session: SessionGuidance) => string> = {
  codex: (session) => codexPrefix(session.tools, skills),
  claude: () =>
    `ace tools are named mcp__ace__<tool>, for example mcp__ace__delegate, and may be deferred: search for ace when a task matches. ${skills}`,
  opencode: () =>
    `OpenCode names ace tools ace_<tool>: guide is ace_guide and delegate is ace_delegate. ${skills} Load them with your skill tool.`,
  cursor: () => `ace tools come from the ace MCP server. ${skills}`,
  antigravity: () => "ace tools come from the ace MCP server.",
  acp: () => "ace tools come from the ace MCP server.",
  pi: () =>
    `ace tools are your ace_<tool> extension tools: guide is ace_guide and delegate is ace_delegate. ${skills}`,
};

/**
 * Guidance for the provider's own system/developer channel. Each provider receives ace's
 * always-on guidance once: through MCP server instructions where the CLI shows them, and
 * through this channel otherwise. Everything task-specific is in the guides it points to.
 * Rendered once per session, so the provider's cached prefix never changes under it.
 */
export function developerInstructions(
  provider: ProviderKind,
  session: SessionGuidance = {},
): string {
  return [
    readsServerInstructions.has(provider) ? undefined : aceGuidance(session.groups),
    prefix[provider](session),
    session.roles,
    session.brief,
  ]
    .filter(Boolean)
    .join("\n");
}
