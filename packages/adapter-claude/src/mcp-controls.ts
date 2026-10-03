import { z } from "zod";
import type { Query, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderMcpControl } from "@ace/engine-api";

const text = z.string().min(1).max(8192);
const headers = z.record(text, z.string().max(8192));
const server = z.union([
  z
    .object({
      type: z.literal("stdio").optional(),
      command: text,
      args: z.array(text).max(256).optional(),
      env: headers.optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("http"), url: z.url(), headers: headers.optional() }).passthrough(),
  z.object({ type: z.literal("sse"), url: z.url(), headers: headers.optional() }).passthrough(),
]);
export const ClaudeMcpServers = z
  .record(z.string().min(1).max(256), server)
  .refine((value) => Object.keys(value).length <= 256, "Claude MCP server capacity reached");
export type ClaudeMcpServers = z.infer<typeof ClaudeMcpServers>;
export function nativeMcpServers(input: unknown): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(ClaudeMcpServers.parse(input)).map(([name, config]) => {
      if (config.type === "http" || config.type === "sse")
        return [
          name,
          {
            ...config,
            type: config.type,
            url: config.url,
            ...(config.headers ? { headers: config.headers } : {}),
          },
        ];
      return [
        name,
        {
          ...config,
          command: config.command,
          ...(config.type ? { type: config.type } : {}),
          ...(config.args ? { args: config.args } : {}),
          ...(config.env ? { env: config.env } : {}),
        },
      ];
    }),
  );
}
const statusResult = z
  .array(z.object({ name: z.string(), status: z.string() }).passthrough())
  .max(256);
const setResult = z
  .object({
    added: z.array(z.string()).max(256),
    removed: z.array(z.string()).max(256),
    errors: z.record(z.string(), z.string()),
  })
  .passthrough();
/** Controls affect the SDK's dynamic set. Settings and plugin ownership stays with the CLI. */
export function mcpControls(query: Query, ensureOpen: () => void): ProviderMcpControl {
  return {
    async status() {
      ensureOpen();
      return statusResult.parse(await query.mcpServerStatus());
    },
    async replace(servers) {
      ensureOpen();
      const result = setResult.parse(await query.setMcpServers(nativeMcpServers(servers)));
      // The original control response is retained by the wire bridge, including extensions.
      if (Object.keys(result.errors).length)
        throw new Error(
          `Claude MCP connection failures: ${Object.entries(result.errors)
            .map(([name, error]) => `${name}: ${error}`)
            .join("; ")}`,
        );
      return result;
    },
    async reconnect(name) {
      ensureOpen();
      await query.reconnectMcpServer(text.parse(name));
    },
    async enable(name) {
      ensureOpen();
      await query.toggleMcpServer(text.parse(name), true);
    },
    async disable(name) {
      ensureOpen();
      await query.toggleMcpServer(text.parse(name), false);
    },
  };
}
