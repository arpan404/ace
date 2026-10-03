import { z } from "zod";
import type { ProviderKind } from "@ace/protocol";

const connection = z.strictObject({
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
export type AceMcpConnection = z.infer<typeof connection>;
export function developerInstructions(provider: ProviderKind): string {
  const prefix: Record<ProviderKind, string> = {
    codex: "Use the ace MCP server's ace_* tools.",
    claude: "Use mcp__ace__* tools for ace operations.",
    opencode: "Use ace_ace_* MCP tools for ace operations.",
    cursor: "Use the ace MCP server for ace operations.",
    antigravity: "Use the ace MCP server for ace operations.",
    acp: "Use the ace MCP server for ace operations.",
  };
  return `${prefix[provider]} Inspect the thread and agent tree for live status. Use delegate_task to start independent child threads on any available provider. Choose wait to await the outcome or continue working; completed children wake you in a batched turn. Creation returns acceptance, not completion. Agents may answer questions but must never resolve approvals. Notify the user when their input is needed. Browser and preview tools appear only when authorized.`;
}
export function codexInjection(input: AceMcpConnection) {
  const { url, bearer } = connection.parse(input);
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
  const { url, bearer } = connection.parse(input);
  return {
    mcpServers: {
      ace: { type: "http" as const, url, headers: { Authorization: `Bearer ${bearer}` } },
    },
    developerInstructions: developerInstructions("claude"),
  };
}
export function openCodeInjection(input: AceMcpConnection) {
  const { url, bearer } = connection.parse(input);
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
  const { url, bearer } = connection.parse(input);
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
