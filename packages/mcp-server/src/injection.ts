import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  codexClientHeader,
  coreToolsHeader,
  staticToolsHeader,
  toolListingHeader,
  type ToolListing,
} from "./toolsets.ts";
import { maxToolTimeoutMs } from "./timeouts.ts";
import { destructiveAceTools } from "./agent-control.ts";
import {
  developerInstructions,
  usualToolListing,
  type SessionGuidance,
} from "./session-guidance.ts";

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
export {
  developerInstructions,
  usualToolListing,
  type SessionGuidance,
} from "./session-guidance.ts";
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
          // Codex lists every tool, but its code-mode models never see a schema: guide and
          // tools_find return schemas and the exec call form to it.
          [codexClientHeader.name]: codexClientHeader.value,
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
/** An ACP lease, with the listing its agent's tool refresh supports (`acpToolListing`). */
type AcpInjected = Injected & { listing?: ToolListing | undefined };
export function acpInjection(
  input: AcpInjected,
  provider: "cursor" | "antigravity" | "acp" = "acp",
) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  // ACP leaves tools/list_changed to each agent. Without a known agent the provider's usual
  // listing applies: Antigravity defers like Claude; the rest keep the core tools, tools_find
  // and tools_call, the one listing every agent can use.
  const listing = input.listing ?? usualToolListing(provider);
  const header = toolListingHeader(listing);
  return {
    mcpServers: [
      {
        type: "http" as const,
        name: "ace",
        url,
        headers: [
          { name: "Authorization", value: `Bearer ${bearer}` },
          { name: "X-Ace-Notifications", value: "stream" },
          ...(header ? [header] : []),
        ],
      },
    ],
    developerInstructions: developerInstructions(provider, { ...input.session?.(), listing }),
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
        // list per connection and never handles tools/list_changed, so it keeps the core tools
        // plus tools_find and reaches the rest through tools_call.
        headers: {
          Authorization: `Bearer ${bearer}`,
          "X-Ace-Instructions": "native",
          "X-Ace-Notifications": "stream",
          [staticToolsHeader.name]: staticToolsHeader.value,
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
  input: AceMcpConnection & { listing?: ToolListing | undefined },
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
          { name: "ACE_MCP_BRIDGE_TOOLS", value: input.listing ?? "static" },
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
