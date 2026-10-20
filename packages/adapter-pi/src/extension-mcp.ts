import { z } from "zod";
import {
  coreToolsHeader,
  developerInstructions,
  maxToolTimeoutMs,
  type AceMcpConnection,
  type SessionGuidance,
} from "@ace/mcp-server";
import { bareToolName } from "@ace/provider-kit/ace-tool-names";
import { obj, str } from "./native.ts";
import type { PiExtensionApi } from "./extension-api.ts";

/** A tool name as ace's MCP server registers it: bare (`context`), or a toolkit's `ace_` name. */
const AceToolName = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]{0,100}$/);

/**
 * Pi has no MCP namespace of its own, so ace namespaces its extension tools the way OpenCode
 * does: `ace_<bare name>` (`ace_guide`, `ace_screen_input`). Pi's transcript maps them back.
 */
export function piToolName(mcpName: string): string {
  return `ace_${bareToolName(mcpName)}`;
}
const Tools = z.object({
  tools: z
    .array(
      z.object({
        name: AceToolName,
        description: z.string().max(16384).optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        annotations: z.object({ readOnlyHint: z.boolean().optional() }).passthrough().optional(),
        _meta: z
          .object({ "ace/timeoutMs": z.number().int().min(1).max(maxToolTimeoutMs).optional() })
          .passthrough()
          .optional(),
      }),
    )
    .max(256),
  nextCursor: z.string().optional(),
});
type ListedTool = z.infer<typeof Tools>["tools"][number];
/** Which listed ace tools this session offers Pi. */
export type AceToolFilter = (tool: ListedTool) => boolean;
export const anyAceTool: AceToolFilter = () => true;
/** Read-only Pi: only the tools ace's server marks read-only (its risk class), never a write. */
export const readOnlyAceTool: AceToolFilter = (tool) => tool.annotations?.readOnlyHint === true;
const SessionResource = z.object({
  brief: z.string().max(4096).optional(),
  roles: z.string().max(1024).nullable().optional(),
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
/**
 * Bounds in-flight ace MCP calls without refusing any: past the cap a call waits for a free slot,
 * and a released slot passes straight to the oldest waiter.
 */
function callSlots(capacity: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (signal: AbortSignal | undefined): Promise<() => void> => {
    signal?.throwIfAborted();
    if (active < capacity && !waiting.length) active++;
    else
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          waiting.splice(waiting.indexOf(wake), 1);
          reject(signal?.reason);
        };
        waiting.push(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
}
type McpClient = InstanceType<(typeof import("@modelcontextprotocol/client"))["Client"]>;

/**
 * ace's MCP tools inside Pi. Pi forbids action methods (active tools, messages, entries) while
 * the extension factory runs and asks that sockets open only once a session exists, so the
 * factory registers hooks alone and the connection and catalogue wait for `session_start`.
 * A failure there is an extension error Pi reports; Pi itself keeps working without ace tools.
 */
export function registerAceMcpTools(
  pi: PiExtensionApi,
  connection: AceMcpConnection,
  offered: AceToolFilter = anyAceTool,
): void {
  // Pi's turn-start hook is synchronous, so the session brief is read from ace://session in the
  // background and the latest copy goes into each turn's system prompt.
  let guidance: SessionGuidance = {};
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
          ...(parsed.data.roles ? { roles: parsed.data.roles } : {}),
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
    if (!event.toolName.startsWith("ace_")) return;
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
      await listen(pi, mcp, offered);
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
async function listen(
  pi: PiExtensionApi,
  client: McpClient,
  offered: AceToolFilter,
): Promise<void> {
  const slot = callSlots(64);
  const registered = new Set<string>();
  const refresh = (catalogValue: unknown) => {
    const catalog = Tools.parse(catalogValue);
    if (catalog.nextCursor) throw new Error("ace MCP catalog exceeds extension budget");
    const tools = catalog.tools.filter(offered);
    for (const tool of tools) {
      const name = piToolName(tool.name);
      if (registered.has(name)) continue;
      registered.add(name);
      pi.registerTool({
        name,
        label: name,
        description: tool.description ?? tool.name,
        promptSnippet: tool.description ?? tool.name,
        parameters: tool.inputSchema,
        async execute(_id, params, signal) {
          const args = z.record(z.string(), z.unknown()).parse(params);
          if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024)
            throw new Error("ace MCP arguments exceed limit");
          const done = await slot(signal);
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
            done();
          }
        },
      });
    }
    if (pi.setActiveTools && pi.getActiveTools) {
      const native = pi.getActiveTools().filter((name) => !registered.has(name));
      pi.setActiveTools([...native, ...tools.map((tool) => piToolName(tool.name))]);
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
