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
    opencode: "Use ace_ace_* MCP tools for ace operations.",
    cursor: "Use the ace MCP server for ace operations.",
    antigravity: "Use the ace MCP server for ace operations.",
    acp: "Use the ace MCP server for ace operations.",
    pi: "Use ace_* extension tools for ace operations.",
  };
  return `${prefix[provider]} Inspect the thread and agent tree for live status. Use delegate_task to start independent child threads on any available provider. Choose wait to await the outcome or continue working; completed children wake you in a batched turn. Creation returns acceptance, not completion. Agents may answer questions but must never resolve approvals. Notify the user when their input is needed. Browser and preview tools appear only when authorized.`;
}
export function codexInjection(input: AceMcpConnection) {
  const { url, bearer } = AceMcpConnectionSchema.parse(input);
  return {
    args: [
      "-c",
      `mcp_servers.ace.url=${JSON.stringify(url)}`,
      "-c",
      'mcp_servers.ace.bearer_token_env_var="ACE_MCP_BEARER_TOKEN"',
    ],
    env: { ACE_MCP_BEARER_TOKEN: bearer },
    developerInstructions: developerInstructions("codex"),
  };
}
export function claudeInjection(input: AceMcpConnection) {
  const { url, bearer } = AceMcpConnectionSchema.parse(input);
  return {
    mcpServers: {
      ace: { type: "http" as const, url, headers: { Authorization: `Bearer ${bearer}` } },
    },
    developerInstructions: developerInstructions("claude"),
  };
}
export function openCodeInjection(input: AceMcpConnection) {
  const { url, bearer } = AceMcpConnectionSchema.parse(input);
  return {
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: {
          ace: {
            type: "remote",
            url,
            enabled: true,
            oauth: false,
            headers: { Authorization: `Bearer ${bearer}` },
          },
        },
      }),
    },
    developerInstructions: developerInstructions("opencode"),
  };
}
export function acpInjection(
  input: AceMcpConnection,
  provider: "cursor" | "antigravity" | "acp" = "acp",
) {
  const { url, bearer } = AceMcpConnectionSchema.parse(input);
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
/** The provider starts this child inside its supervised process group. Lease travels in env. */
export function acpStdioInjection(
  input: AceMcpConnection,
  runtime: { command: string; entrypoint: string } = {
    command: process.execPath,
    entrypoint: fileURLToPath(new URL("./stdio-entry.ts", import.meta.url)),
  },
) {
  const { url, bearer } = AceMcpConnectionSchema.parse(input);
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
