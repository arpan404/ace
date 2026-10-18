import { onTestFinished } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { browserToolkit } from "./index.ts";
import type { BrowserService } from "./service.ts";

const Content = z.object({
  isError: z.boolean().optional(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), mimeType: z.string(), data: z.string() }),
    ]),
  ),
});
export const Failure = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string(),
  detail: z.string().optional(),
});

/** The JSON a text content item carries. */
function text(result: z.infer<typeof Content>, index = 0): unknown {
  const item = result.content[index];
  if (item?.type !== "text") throw new Error("Expected text content");
  return JSON.parse(item.text);
}

/** An agent calling ace_browser_* tools over the real MCP registry, as a provider would. */
export function agentMcp(service: Pick<BrowserService, "execute" | "screenshot">) {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  browserToolkit(service).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "provider",
      threadId: "thread",
      agentId: "root",
      capabilities: ["browser"],
    }),
    new AbortController().signal,
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    Content.parse(
      await registry.call(
        `ace_browser_${name}`,
        args,
        lease.principal,
        new AbortController().signal,
      ),
    );
  return {
    call,
    text,
    /** The call's result; it must succeed. */
    async ok(name: string, args: Record<string, unknown> = {}) {
      const result = await call(name, args);
      if (result.isError)
        throw new Error(`ace_browser_${name} failed: ${JSON.stringify(text(result))}`);
      return result;
    },
    /** The public failure the agent reads; the call must fail. */
    async failure(name: string, args: Record<string, unknown> = {}) {
      const result = await call(name, args);
      if (!result.isError) throw new Error(`ace_browser_${name} succeeded`);
      return Failure.parse(text(result));
    },
  };
}
