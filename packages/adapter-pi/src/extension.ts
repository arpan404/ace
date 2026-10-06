import { PermissionMode } from "@ace/protocol";
import { registerPiContextSamples } from "./context-usage.ts";
import { registerPiToolGate } from "./tool-approval.ts";
import { z } from "zod";
import { readPrivateMcpConfig, AceMcpConnectionSchema } from "@ace/mcp-server";
import { obj, str } from "./native.ts";
import type { PiExtensionApi } from "./extension-api.ts";
const ToolName = z
  .string()
  .max(128)
  .regex(/^(?:delegate_task|(?:ace_|screen_|device_)[a-z0-9_]+)$/);
const Tools = z.object({
  tools: z
    .array(
      z.object({
        name: ToolName,
        description: z.string().max(16384).optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        _meta: z
          .object({ "ace/timeoutMs": z.number().int().min(1).max(300000).optional() })
          .passthrough()
          .optional(),
      }),
    )
    .max(256),
  nextCursor: z.string().optional(),
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
        if (bytes > 1024 * 1024) {
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
/** Runs inside installed Pi. All provider auth remains Pi-owned. */
export default async function aceExtension(
  pi: PiExtensionApi,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const session = z
    .object({
      controlSecret: z.string().regex(/^[a-f0-9]{64}$/),
      mcp: AceMcpConnectionSchema.optional(),
    })
    .parse(JSON.parse(readPrivateMcpConfig(z.string().parse(env.ACE_PI_SESSION_FILE))));
  // Pi shell tools inherit this process's environment. Keep authority only in this closure.
  delete env.ACE_PI_SESSION_FILE;
  const secret = session.controlSecret;
  registerPiContextSamples(pi);
  registerPiToolGate(pi, PermissionMode.parse(env.ACE_PI_PERMISSION_MODE ?? "read-only"));
  pi.registerCommand("ace-rollback", {
    description: "ace conversation navigation",
    async handler(args, ctx) {
      const [supplied, id, requestId, ...rest] = args.split(" ");
      if (supplied !== secret || !id || !requestId || rest.length || !/^[-a-zA-Z0-9_]+$/.test(id))
        throw new Error("Unauthorized ace navigation");
      try {
        await ctx.waitForIdle();
        const result = await ctx.navigateTree(id, { summarize: false });
        if (!result.cancelled) pi.appendEntry("ace-navigation", { targetId: id });
        ctx.ui.notify(
          JSON.stringify({ type: "ace_rollback", id: requestId, success: !result.cancelled }),
          "info",
        );
      } catch {
        ctx.ui.notify(
          JSON.stringify({ type: "ace_rollback", id: requestId, success: false }),
          "error",
        );
      }
    },
  });
  pi.registerCommand("ace-context", {
    description: "ace-originated delegation context",
    async handler(args) {
      const [supplied, encoded, ...rest] = args.split(" ");
      if (
        supplied !== secret ||
        !encoded ||
        rest.length ||
        encoded.length > 800000 ||
        !/^[A-Za-z0-9+/=]+$/.test(encoded)
      )
        throw new Error("Unauthorized ace context");
      if (!pi.sendMessage) throw new Error("Pi custom context is unavailable");
      const content = Buffer.from(encoded, "base64").toString("utf8");
      pi.sendMessage(
        {
          customType: "ace.delegation.settled",
          content,
          display: false,
          details: { origin: "ace" },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });
  if (!session.mcp) return;
  const connection = session.mcp;
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const client = new Client(
    { name: "ace-pi", version: "0.1.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  let calls = 0;
  pi.on("tool_result", (event) => {
    if (!ToolName.safeParse(event.toolName).success) return;
    const result = obj(obj(event.details).aceMcp);
    return typeof result.isError === "boolean" ? { isError: result.isError } : undefined;
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.bearer}` } },
        fetch: boundedFetch,
      }),
    );
    const catalog = Tools.parse(await client.listTools());
    if (catalog.nextCursor) throw new Error("ace MCP catalog exceeds extension budget");
    for (const tool of catalog.tools)
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
    pi.on("session_shutdown", () => client.close());
  } catch (error) {
    await client.close();
    throw error;
  }
}
