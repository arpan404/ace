import { z } from "zod";

/*
 * An MCP app's page shown as a Spade panel (ADR 0202 §4, MCP Apps 2026-01-26): the page speaks
 * JSON-RPC 2.0 to its host. Each message out of it is checked with these on the host, after the
 * outer document has written it as JSON text within the panel bound. The host acts on a few
 * methods only (`ui/initialize`, `tools/call`, `ui/message`, `ui/update-model-context`,
 * `ui/open-link`, `ui/request-display-mode`, `ping`) and refuses every other request.
 */

/** The MCP Apps version this mapping was written for. */
export const mcpAppsVersion = "2026-01-26";

const Id = z.union([z.string().max(100), z.number().int()]);
const Method = z.string().min(1).max(80);

export const McpAppRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: Id,
  method: Method,
  params: z.unknown().optional(),
});
export type McpAppRequest = z.infer<typeof McpAppRequest>;
export const McpAppNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: Method,
  params: z.unknown().optional(),
});
export type McpAppNotification = z.infer<typeof McpAppNotification>;
export const McpAppResponse = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: Id, result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: Id, error: z.unknown() }),
]);

/** What an MCP app's page may send: a request, a notification, or an answer to the host. */
export const McpAppPageMessage = z.union([McpAppRequest, McpAppNotification, McpAppResponse]);
export type McpAppPageMessage = z.infer<typeof McpAppPageMessage>;

export const McpAppToolCall = z.object({
  name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
export const McpAppMessage = z.object({
  role: z.literal("user"),
  content: z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  ]),
});
export const McpAppModelContext = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
export const McpAppOpenLink = z.object({ url: z.string().max(2000) });

/** What ace sends an MCP app's page: JSON-RPC requests, answers and notifications. */
export type McpAppHostMessage =
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | { jsonrpc: "2.0"; id: string | number; error: { code: number; message: string } }
  | { jsonrpc: "2.0"; method: string; params?: unknown };
