import { fileURLToPath } from "node:url";
import { z } from "zod";
import { aceInstructions } from "./status.ts";
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
const prefix: Record<ProviderKind, string> = {
  codex: "Use the ace MCP server's ace_* tools.",
  claude:
    "ace tools are named mcp__ace__<tool>, for example mcp__ace__delegate_task; they may be deferred, so search for ace when a task matches.",
  opencode:
    "OpenCode prefixes every ace MCP tool with ace_: ace_status is ace_ace_status, and delegate_task is ace_delegate_task.",
  cursor: "Use the ace MCP server for ace operations.",
  antigravity: "Use the ace MCP server for ace operations.",
  acp: "Use the ace MCP server for ace operations.",
  pi: "Use ace_*, screen_* and device_* extension tools for ace operations.",
};
const title =
  "New conversation with a provisional title (the session facts say so): during your first turn, set a concise title from the person's request with ace_thread_rename and onlyIfProvisional: true, without another model request. Keep titles a person or agent chose.";
const visualize =
  "For charts, diagrams, comparisons or mockups that explain more than prose, use the bundled visualize skill and ace_html_render.";
const screen =
  "Never drive Safari/Chrome/Arc/Firefox with screen_*; websites use ace_browser_*. Use screen_* only when the person asks you to operate a specific native app or nothing else can: call screen_request_app, then screen_ui_tree or screen_ui_find before coordinates.";
const devices =
  "Approved simulators and devices: device_list, then device_find before coordinate input.";
const delegation =
  "delegate_task returns child thread ids at once. To use their results this turn, call ace_wait with the ids and timeoutSeconds (or give delegate_task several tasks with await: all); on timeout, wait again; on needs_you, tell the person what each child asks. ace_agents_status shows the whole tree compactly. Never poll. If you end your turn instead, settled results arrive as a new turn.";
const machines =
  "To work on another of the person's machines, call ace_machines, then pass its machine name to delegate_task (with project) or to ace_browser_* tools; that machine's own access and consent apply.";
const remote =
  "Paired machines: ace_device_list, then ace_device_delegate with an explicit hostId and workspaceId sends independent work; ace_device_task_status, ace_device_task_wait and ace_device_task_cancel control it. On a remote task, call ace_device_task_publish once before finishing to return files. Workspaces are never overwritten or merged.";

/**
 * Guidance for the provider's own system/developer channel. Each provider receives ace's
 * guidance once: the shared part goes through MCP server instructions where the CLI shows them,
 * and through this channel otherwise. Group-specific lines appear only for enabled groups.
 */
export function developerInstructions(
  provider: ProviderKind,
  session: SessionGuidance = {},
): string {
  const has = (group: string) => !session.groups || session.groups.includes(group);
  return [
    readsServerInstructions.has(provider) ? undefined : aceInstructions,
    prefix[provider],
    title,
    visualize,
    has("screen") ? screen : undefined,
    has("devices") ? devices : undefined,
    has("agents") ? delegation : undefined,
    has("agents") ? machines : undefined,
    has("agents") ? remote : undefined,
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
        // the answer. ace already asks for what needs a person (new browser origins, app
        // control, evaluate, uploads) inside the tool, in every permission mode, so only the
        // tools that overwrite work or commit spending keep Codex's own prompt.
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
    headers: { Authorization: `Bearer ${bearer}`, "X-Ace-Notifications": "stream" },
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
        // Guidance travels once, in Cursor's always-applied rule.
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
