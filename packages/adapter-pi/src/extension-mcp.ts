import { z } from "zod";
import {
  coreToolsHeader,
  developerInstructions,
  maxToolTimeoutMs,
  type AceMcpConnection,
} from "@ace/mcp-server";
import { obj, str } from "./native.ts";
import type { PiExtensionApi } from "./extension-api.ts";

export const AceToolName = z
  .string()
  .max(128)
  .regex(/^(?:delegate_task|(?:ace_|screen_|device_)[a-z0-9_]+)$/);
const Tools = z.object({
  tools: z
    .array(
      z.object({
        name: AceToolName,
        description: z.string().max(16384).optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        _meta: z
          .object({ "ace/timeoutMs": z.number().int().min(1).max(maxToolTimeoutMs).optional() })
          .passthrough()
          .optional(),
      }),
    )
    .max(256),
  nextCursor: z.string().optional(),
});
const SessionResource = z.object({
  brief: z.string().max(4096).optional(),
  facts: z.object({ groups: z.array(z.string().max(64)).max(32) }),
});
const Result = z.object({
  content: z.array(z.unknown()).max(256),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});
const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "error" });
  const body = response.body;
  if (!body) return response;
  const reader = body.getReader();
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const subscription = headers.get("MCP-Method") === "subscriptions/listen";
  let bytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (!subscription && bytes > 1024 * 1024) {
          await reader.cancel();
          controller.error(new Error("ace MCP response exceeds limit"));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: () => reader.cancel(),
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
type McpClient = InstanceType<(typeof import("@modelcontextprotocol/client"))["Client"]>;

/**
 * ace's MCP tools inside Pi. Pi forbids action methods (active tools, messages, entries) while
 * the extension factory runs and asks that sockets open only once a session exists, so the
 * factory registers hooks alone and the connection and catalogue wait for `session_start`.
 * A failure there is an extension error Pi reports; Pi itself keeps working without ace tools.
 */
export function registerAceMcpTools(pi: PiExtensionApi, connection: AceMcpConnection): void {
  // Pi's turn-start hook is synchronous, so the session brief is read from ace://session in the
  // background and the latest copy goes into each turn's system prompt.
  let guidance: { brief?: string; groups?: string[] } = {};
  let client: McpClient | undefined;
  let started: Promise<void> | undefined;
  let closed = false;
  const refreshGuidance = async () => {
    try {
      if (!client) return;
      const read = await client.readResource({ uri: "ace://session" });
      const text = obj(read.contents[0]).text;
      const parsed = SessionResource.safeParse(JSON.parse(str(text)));
      if (parsed.success)
        guidance = {
          ...(parsed.data.brief ? { brief: parsed.data.brief } : {}),
          groups: parsed.data.facts.groups,
        };
    } catch {
      /* Older daemons have no session resource; the static guidance still applies. */
    }
  };
  pi.on("before_agent_start", (event) => {
    const systemPrompt = `${event.systemPrompt}\n\n${developerInstructions("pi", guidance)}`;
    void refreshGuidance();
    return { systemPrompt };
  });
  pi.on("tool_result", (event) => {
    if (!AceToolName.safeParse(event.toolName).success) return;
    const result = obj(obj(event.details).aceMcp);
    return typeof result.isError === "boolean" ? { isError: result.isError } : undefined;
  });
  const close = async () => {
    closed = true;
    await client?.close();
  };
  const connect = async () => {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    if (closed) return;
    const mcp = new Client(
      { name: "ace-pi", version: "0.1.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    client = mcp;
    try {
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(connection.url), {
          // Pi registers every listed tool upfront: ace lists its core tools and opens the rest.
          requestInit: {
            headers: {
              Authorization: `Bearer ${connection.bearer}`,
              [coreToolsHeader.name]: coreToolsHeader.value,
            },
          },
          fetch: boundedFetch,
        }),
      );
      await refreshGuidance();
      await listen(pi, mcp);
    } catch (error) {
      await mcp.close();
      throw error;
    }
  };
  // Pi awaits session_start before it reads RPC input, so the tools exist before the first turn.
  pi.on("session_start", () => (started ??= connect()));
  pi.on("session_shutdown", close);
}

/** Registers the catalogue's tools, keeps them active beside Pi's own, and follows changes. */
async function listen(pi: PiExtensionApi, client: McpClient): Promise<void> {
  let calls = 0;
  const registered = new Set<string>();
  const refresh = (catalogValue: unknown) => {
    const catalog = Tools.parse(catalogValue);
    if (catalog.nextCursor) throw new Error("ace MCP catalog exceeds extension budget");
    for (const tool of catalog.tools) {
      if (registered.has(tool.name)) continue;
      registered.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description ?? tool.name,
        promptSnippet: tool.description ?? tool.name,
        parameters: tool.inputSchema,
        async execute(_id, params, signal) {
          if (calls >= 16) throw new Error("ace MCP call capacity exceeded");
          const args = z.record(z.string(), z.unknown()).parse(params);
          if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024)
            throw new Error("ace MCP arguments exceed limit");
          calls++;
          try {
            const result = Result.parse(
              await client.callTool(
                { name: tool.name, arguments: args },
                {
                  ...(signal ? { signal } : {}),
                  timeout: tool["_meta"]?.["ace/timeoutMs"] ?? 30_000,
                },
              ),
            );
            return {
              content: result.content.map((block) => {
                const value = obj(block);
                if (value.type === "text") return { type: "text", text: str(value.text) };
                if (value.type === "image")
                  return { type: "image", data: str(value.data), mimeType: str(value.mimeType) };
                return { type: "text", text: JSON.stringify(block) };
              }),
              details: {
                aceMcp: {
                  isError: result.isError ?? false,
                  structuredContent: result.structuredContent,
                },
              },
            };
          } finally {
            calls--;
          }
        },
      });
    }
    if (pi.setActiveTools && pi.getActiveTools) {
      const native = pi.getActiveTools().filter((name) => !registered.has(name));
      pi.setActiveTools([...native, ...catalog.tools.map((tool) => tool.name)]);
    }
  };
  refresh(await client.listTools());
  let refreshPending = false;
  let refreshing: Promise<void> | undefined;
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    refreshPending = true;
    refreshing ??= (async () => {
      while (refreshPending) {
        refreshPending = false;
        refresh(await client.listTools());
      }
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  });
  await client.listen({ toolsListChanged: true });
}
