import { onTestFinished } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { browserToolkit, type BrowserToolPort } from "./index.ts";

const Content = z.object({
  isError: z.boolean().optional(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), mimeType: z.string(), data: z.string() }),
    ]),
  ),
});
type Result = z.infer<typeof Content>;
export const Failure = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string(),
  detail: z.string().optional(),
});

/** A text content item as the agent reads it. */
function raw(result: Result, index = 0): string {
  const item = result.content.filter((part) => part.type === "text")[index];
  if (item?.type !== "text") throw new Error("Expected text content");
  return item.text;
}

/** The ref on the snapshot line naming `name`, as an agent would pick it out. */
export function refNamed(snapshot: string, name: string): string {
  const quoted = JSON.stringify(name);
  const line = snapshot
    .split("\n")
    .find((entry) => entry.includes(quoted) && entry.includes("[ref="));
  const found = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (!found) throw new Error(`No ${quoted} ref in snapshot:\n${snapshot}`);
  return found;
}

/** An agent calling the browser tools over the real MCP registry, as a provider would. */
export function agentMcp(port: BrowserToolPort) {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  browserToolkit(port).register(registry);
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
    Content.parse(await registry.call(name, args, lease.principal, new AbortController().signal));
  return {
    call,
    /** A text item's raw text, such as a snapshot. */
    raw,
    /** The JSON a text item carries. */
    json: (result: Result, index = 0): unknown => JSON.parse(raw(result, index)),
    /** The call's result; it must succeed. */
    async ok(name: string, args: Record<string, unknown> = {}) {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} failed: ${raw(result)}`);
      return result;
    },
    /** The public failure the agent reads; the call must fail. */
    async failure(name: string, args: Record<string, unknown> = {}) {
      const result = await call(name, args);
      if (!result.isError) throw new Error(`${name} succeeded`);
      return Failure.parse(JSON.parse(raw(result)));
    },
  };
}
