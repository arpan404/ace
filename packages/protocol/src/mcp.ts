import { z } from "zod";
import { AgentId, ThreadId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";

export const McpCapability = z.enum([
  "browser",
  "preview",
  "terminal",
  "notify",
  "agents",
  "thread_control",
  "automations",
  "projects",
  "forge",
  "screen",
]);
export type McpCapability = z.infer<typeof McpCapability>;
export const McpScope = z.object({
  sessionId: z.string().min(1).max(256),
  threadId: ThreadId,
  agentId: AgentId,
  capabilities: z.array(McpCapability).max(10),
});
export type McpScope = z.infer<typeof McpScope>;
export const McpAttribution = McpScope.omit({ capabilities: true });
export type McpAttribution = z.infer<typeof McpAttribution>;
export const McpNoticeInput = z.strictObject({
  text: z.string().min(1).max(4096),
  level: z.enum(["info", "warning", "error"]).default("info"),
});
export const McpNotificationIntent = McpAttribution.extend({
  type: z.literal("mcp.notify"),
  notice: McpNoticeInput,
});
export type McpNotificationIntent = z.infer<typeof McpNotificationIntent>;
export const McpSpawnInput = z.strictObject({
  task: z.string().min(1).max(16384),
  provider: ProviderKind.optional(),
  name: z.string().min(1).max(128).optional(),
});
export const McpSpawnIntent = McpAttribution.extend({
  type: z.literal("mcp.spawn"),
  input: McpSpawnInput,
});
export type McpSpawnIntent = z.infer<typeof McpSpawnIntent>;
export const McpIntent = z.discriminatedUnion("type", [McpNotificationIntent, McpSpawnIntent]);
export type McpIntent = z.infer<typeof McpIntent>;
export const PendingMcpIntent = z.object({ id: z.string().min(1).max(256), intent: McpIntent });
export type PendingMcpIntent = z.infer<typeof PendingMcpIntent>;

const providerRequest = z.object({ requestId: z.string().min(1).max(512), threadId: ThreadId });
const serverName = z.string().min(1).max(256);
export const McpProviderRequest = z.discriminatedUnion("type", [
  providerRequest.extend({ type: z.literal("mcp.status") }),
  providerRequest.extend({
    type: z.literal("mcp.replace"),
    servers: z
      .record(serverName, z.unknown())
      .refine((servers) => Object.keys(servers).length <= 256)
      .meta({ maxProperties: 256, "x-ace-constraint": "At most 256 dynamic MCP servers." }),
  }),
  providerRequest.extend({ type: z.literal("mcp.reconnect"), name: serverName }),
  providerRequest.extend({ type: z.literal("mcp.enable"), name: serverName }),
  providerRequest.extend({ type: z.literal("mcp.disable"), name: serverName }),
]);
export const McpProviderResult = providerRequest.extend({
  type: z.literal("mcp.result"),
  result: z.unknown(),
});
