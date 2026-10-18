import { fileURLToPath } from "node:url";
import { z } from "zod";
import { aceGuidance } from "./status.ts";
import { coreToolsHeader } from "./toolsets.ts";
import { maxToolTimeoutMs } from "./timeouts.ts";
import { destructiveAceTools } from "./agent-control.ts";
import type { ProviderKind } from "@ace/protocol";

export const AceMcpConnectionSchema = z.strictObject({
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !!url.port &&
      url.pathname === "/mcp" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Expected ace loopback MCP endpoint"),
  bearer: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AceMcpConnection = z.infer<typeof AceMcpConnectionSchema>;
/** Providers whose CLI shows MCP server instructions to the model; the rest opt out. */
const readsServerInstructions = new Set<ProviderKind>(["claude", "opencode", "acp", "antigravity"]);
/** What the daemon knows about this session when it injects guidance. */
export interface SessionGuidance {
  /** The session brief (facts), rendered by `renderBrief`. */
  brief?: string | undefined;
  /** Enabled ace groups. Omitted: guidance for every group. */
  groups?: readonly string[] | undefined;
}
/** Where the provider natively lists ace's shipped skills; the rest read them via `guide`. */
const skills = "The ace guides are also installed as skills of the same names.";
/** How each provider spells ace's bare tool names (its MCP namespace for server `ace`). */
const prefix: Record<ProviderKind, string> = {
  codex: `ace tools come from the ace MCP server (mcp__ace__<tool>) and may be deferred: search for ace when a task matches. ${skills}`,
  claude: `ace tools are named mcp__ace__<tool>, for example mcp__ace__delegate, and may be deferred: search for ace when a task matches. ${skills}`,
  opencode: `OpenCode names ace tools ace_<tool>: guide is ace_guide and delegate is ace_delegate. ${skills} Load them with your skill tool.`,
  cursor: `ace tools come from the ace MCP server. ${skills}`,
  antigravity: "ace tools come from the ace MCP server.",
  acp: "ace tools come from the ace MCP server.",
  pi: `ace tools are your ace_<tool> extension tools: guide is ace_guide and delegate is ace_delegate. ${skills}`,
};

/**
 * Guidance for the provider's own system/developer channel. Each provider receives ace's
 * always-on guidance once: through MCP server instructions where the CLI shows them, and
 * through this channel otherwise. Everything task-specific is in the guides it points to.
 */
export function developerInstructions(
  provider: ProviderKind,
  session: SessionGuidance = {},
): string {
  return [
    readsServerInstructions.has(provider) ? undefined : aceGuidance(session.groups),
    prefix[provider],
    session.brief,
  ]
    .filter(Boolean)
    .join("\n");
}
/** A lease plus, when the daemon has one, this session's guidance (read once at injection). */
type Injected = AceMcpConnection & { session?: (() => SessionGuidance) | undefined };
export function codexInjection(input: Injected) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  return {
    config: {
      "mcp_servers.ace": {
        url,
        http_headers: {
          Authorization: `Bearer ${bearer}`,
          "X-Ace-Instructions": "native",
          "X-Ace-Notifications": "stream",
        },
        tool_timeout_sec: maxToolTimeoutMs / 1000,
        // Codex otherwise gates every ace tool it can't prove read-only and never remembers
        // the answer. ace's tools are always allowed once called and ace never asks inside
        // them, so only the tools that overwrite work or commit spending keep Codex's prompt.
        default_tools_approval_mode: "approve",
        tools: Object.fromEntries(
          destructiveAceTools.map((tool) => [tool, { approval_mode: "prompt" }]),
        ),
      },
    },
    developerInstructions: developerInstructions("codex", input.session?.()),
  };
}
export function claudeInjection(input: Injected) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  return {
    env: { MCP_TOOL_TIMEOUT: String(maxToolTimeoutMs) },
    mcpServers: {
      ace: {
        type: "http" as const,
        url,
        headers: { Authorization: `Bearer ${bearer}`, "X-Ace-Notifications": "stream" },
      },
    },
    developerInstructions: developerInstructions("claude", input.session?.()),
  };
}
export function openCodeInjection(input: Injected) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  const server = {
    type: "remote" as const,
    url,
    disabled: false,
    codemode: false,
    oauth: false as const,
    protocol: "2026-07-28" as const,
    timeout: { execution: maxToolTimeoutMs },
    // OpenCode lists every MCP tool upfront and reloads them on tools/list_changed (2.0.22,
    // packages/core/src/tool/mcp.ts): ace offers its core tools and opens the rest on use.
    headers: {
      Authorization: `Bearer ${bearer}`,
      "X-Ace-Notifications": "stream",
      [coreToolsHeader.name]: coreToolsHeader.value,
    },
  };
  return {
    server,
    developerInstructions: developerInstructions("opencode", input.session?.()),
  };
}
export function acpInjection(input: Injected, provider: "cursor" | "antigravity" | "acp" = "acp") {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  return {
    mcpServers: [
      {
        type: "http" as const,
        name: "ace",
        url,
        // ACP leaves tools/list_changed to each agent and most never refresh, so the whole
        // catalogue is listed: a tool the agent never lists is one its model can never call.
        headers: [
          { name: "Authorization", value: `Bearer ${bearer}` },
          { name: "X-Ace-Notifications", value: "stream" },
        ],
      },
    ],
    developerInstructions: developerInstructions(provider, input.session?.()),
  };
}

/** Cursor's public SDK HTTP MCP transport, never local.customTools. */
export function cursorSdkInjection(input: Injected) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  return {
    mcpServers: {
      ace: {
        type: "http" as const,
        url,
        // Guidance travels once, in Cursor's always-applied rule. Cursor's SDK caches the tool
        // list per connection and never handles tools/list_changed, so it lists every tool.
        headers: {
          Authorization: `Bearer ${bearer}`,
          "X-Ace-Instructions": "native",
          "X-Ace-Notifications": "stream",
        },
      },
    },
    developerInstructions: developerInstructions("cursor", input.session?.()),
  };
}

/** Scrub before building a persisted provider payload, including echoed stderr. */
export function redactMcpCredential(encoded: string, input?: AceMcpConnection): string {
  return input ? encoded.replaceAll(input.bearer, "<ACE_MCP_CREDENTIAL>") : encoded;
}
/** The provider starts this child inside its supervised process group. Lease travels in env. */
export function acpStdioInjection(
  input: AceMcpConnection,
  runtime: { command: string; entrypoint: string } = {
    command: process.execPath,
    entrypoint: fileURLToPath(new URL("./stdio-entry.ts", import.meta.url)),
  },
) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  return {
    mcpServers: [
      {
        name: "ace",
        command: runtime.command,
        args: [runtime.entrypoint],
        env: [
          { name: "ACE_MCP_BRIDGE_URL", value: url },
          { name: "ACE_MCP_BRIDGE_BEARER", value: bearer },
        ],
      },
    ],
  };
}
/** Preserve user definitions and reject a visible collision instead of silently replacing one. */
export function appendAcpMcp(user: readonly unknown[], injected: readonly unknown[]): unknown[] {
  const server = z.object({ name: z.string().min(1).max(256) }).passthrough();
  if (user.length + injected.length > 64) throw new Error("ACP MCP server capacity exceeded");
  const names = new Set<string>();
  for (const value of [...user, ...injected]) {
    const name = server.parse(value).name;
    if (names.has(name)) throw new Error(`ACP MCP server name collision: ${name}`);
    names.add(name);
  }
  return [...user, ...injected];
}
