import { fileURLToPath } from "node:url";
import { z } from "zod";
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
export function developerInstructions(provider: ProviderKind): string {
  const prefix: Record<ProviderKind, string> = {
    codex: "Use the ace MCP server's ace_* tools.",
    claude: "Use mcp__ace__* tools for ace operations.",
    opencode:
      "Use native ace_* MCP tools for ace operations, including ace_screen_* and ace_device_*.",
    cursor: "Use the ace MCP server for ace operations.",
    antigravity: "Use the ace MCP server for ace operations.",
    acp: "Use the ace MCP server for ace operations.",
    pi: "Use ace_*, screen_* and device_* extension tools for ace operations.",
  };
  return `${prefix[provider]} Inspect the thread and agent tree for live status. Use delegate_task to start independent child threads on any available provider. Choose wait to await the outcome or continue working; completed children wake you in a batched turn. Creation returns acceptance, not completion. Agents may answer questions but must never resolve approvals. Notify the user when their input is needed. Browser, preview, screen and device tools appear only when authorized. Use ace_browser_open then ace_browser_snapshot for web pages; do not call cua_repl or provider browser tools for ace's thread browser. Use screen_ui_tree/screen_ui_find for the human-delegated app, or device_list/device_find for an approved simulator. Inspect semantic trees before using coordinate input. If delegation is missing or a human owns control, report the tool error and wait for the user.`;
}
export function codexInjection(input: AceMcpConnection) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  return {
    config: {
      "mcp_servers.ace": {
        url,
        http_headers: { Authorization: `Bearer ${bearer}` },
        tool_timeout_sec: 300,
      },
    },
    developerInstructions: developerInstructions("codex"),
  };
}
export function claudeInjection(input: AceMcpConnection) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  return {
    env: { MCP_TOOL_TIMEOUT: "300000" },
    mcpServers: {
      ace: { type: "http" as const, url, headers: { Authorization: `Bearer ${bearer}` } },
    },
    developerInstructions: developerInstructions("claude"),
  };
}
export function openCodeInjection(input: AceMcpConnection) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  const server = {
    type: "remote" as const,
    url,
    disabled: false,
    codemode: false,
    oauth: false as const,
    protocol: "2026-07-28" as const,
    timeout: { execution: 300_000 },
    headers: { Authorization: `Bearer ${bearer}` },
  };
  return {
    server,
    developerInstructions: developerInstructions("opencode"),
  };
}
export function acpInjection(
  input: AceMcpConnection,
  provider: "cursor" | "antigravity" | "acp" = "acp",
) {
  const { url, bearer } = AceMcpConnectionSchema.parse({ url: input.url, bearer: input.bearer });
  return {
    mcpServers: [
      {
        type: "http" as const,
        name: "ace",
        url,
        headers: [{ name: "Authorization", value: `Bearer ${bearer}` }],
      },
    ],
    developerInstructions: developerInstructions(provider),
  };
}

/** Cursor's public SDK HTTP MCP transport, never local.customTools. */
export function cursorSdkInjection(input: AceMcpConnection) {
  const { url, bearer } = AceMcpConnectionSchema.parse(input);
  return {
    mcpServers: {
      ace: { type: "http" as const, url, headers: { Authorization: `Bearer ${bearer}` } },
    },
    developerInstructions: developerInstructions("cursor"),
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
