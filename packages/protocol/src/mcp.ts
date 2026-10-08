import { z } from "zod";
import { AgentId, ThreadId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";
import { PermissionMode } from "./permissions.ts";

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
  "devices",
]);
export type McpCapability = z.infer<typeof McpCapability>;
export const McpScope = z.object({
  sessionId: z.string().min(1).max(256),
  threadId: ThreadId,
  agentId: AgentId,
  capabilities: z.array(McpCapability).max(McpCapability.options.length),
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

export const McpServerInput = z.discriminatedUnion("transport", [
  z.strictObject({
    transport: z.literal("command"),
    command: z.string().min(1).max(2048),
    args: z.array(z.string().max(2048)).max(64).default([]),
  }),
  z.strictObject({
    transport: z.literal("http"),
    url: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      })
      .meta({
        examples: ["https://example.invalid/mcp"],
        "x-ace-constraint":
          "HTTP or HTTPS URL without credentials, query parameters or a fragment.",
      }),
  }),
]);
export type McpServerInput = z.infer<typeof McpServerInput>;
export const McpSourceServer = z.object({
  name: z.string().min(1).max(256),
  /** `needs_auth`: the server waits for its own sign-in. It never says anything about the provider. */
  status: z.enum(["connected", "connecting", "disabled", "failed", "needs_auth", "unknown"]),
});
export const McpSources = z.object({
  /** No longer filled (ace's own tools live in the side panel); kept so older clients still parse. */
  groups: z.array(z.string().max(64)).max(16).default([]),
  servers: z.array(McpSourceServer).max(512),
  live: z.boolean(),
  canAdd: z.boolean(),
  appliesNextTurn: z.boolean().default(false),
});
export type McpSources = z.infer<typeof McpSources>;

const providerRequest = z.object({ requestId: z.string().min(1).max(512), threadId: ThreadId });
/** Provider-wide scope for Settings: the provider's most recent live session the caller may read. */
const providerScope = z.object({ requestId: z.string().min(1).max(512), provider: ProviderKind });
const serverName = z.string().min(1).max(256);
const addedName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((name) => name !== "ace")
  .meta({ "x-ace-constraint": "The service-owned name ace is reserved." });
export const McpProviderRequest = z.discriminatedUnion("type", [
  providerRequest.extend({ type: z.literal("mcp.status") }),
  providerRequest.extend({ type: z.literal("mcp.sources") }),
  providerRequest.extend({
    type: z.literal("mcp.add"),
    name: addedName,
    server: McpServerInput,
  }),
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
  providerScope.extend({ type: z.literal("mcp.provider.sources") }),
  providerScope.extend({
    type: z.literal("mcp.provider.add"),
    name: addedName,
    server: McpServerInput,
  }),
  providerScope.extend({ type: z.literal("mcp.provider.reconnect"), name: serverName }),
  providerScope.extend({ type: z.literal("mcp.provider.enable"), name: serverName }),
  providerScope.extend({ type: z.literal("mcp.provider.disable"), name: serverName }),
]);
export type McpProviderRequest = z.infer<typeof McpProviderRequest>;
/** Answers a thread-scoped request with its `threadId`, a provider-scoped one with its `provider`. */
export const McpProviderResult = z.object({
  type: z.literal("mcp.result"),
  requestId: z.string().min(1).max(512),
  threadId: ThreadId.optional(),
  provider: ProviderKind.optional(),
  result: z.unknown(),
});

/** Cheap discovery for the authenticated caller, without session secrets or provider data. */
export const McpStatus = z.strictObject({
  threadId: ThreadId,
  agentId: AgentId,
  permissionMode: PermissionMode.nullable(),
  groups: z
    .array(
      z.strictObject({
        name: z.enum(["thread", ...McpCapability.options, "files"]),
        enabled: z.boolean(),
        reason: z.string().max(512).optional(),
      }),
    )
    .max(McpCapability.options.length + 2),
});
export type McpStatus = z.infer<typeof McpStatus>;
