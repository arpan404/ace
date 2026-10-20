import { expect, test } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { createDaemonLogger } from "./diagnostic-log.ts";
import { toolFailureReporter } from "./tool-failure-log.ts";

const Failure = z.object({ code: z.string(), message: z.string(), errorId: z.string() });

function failingTool() {
  throw new TypeError("cannot read rows of undefined in /private/var/ace/secret-plan.md");
}

test("an unexpected tool error is logged with its stack and the agent sees a correlation id but not the error text", async () => {
  const log = createDaemonLogger(
    { sink: { async write() {}, async close() {} }, now: () => 1 },
    { env: {} },
  );
  let next = 0;
  const registry = new ToolRegistry({
    scheduler: { after: () => () => {} },
    reportFailure: toolFailureReporter(log, () => `failure-${++next}`),
  });
  registry.register({
    name: "thread_read",
    description: "Read a thread",
    capability: null,
    timeoutMs: 1000,
    input: z.strictObject({}),
    output: z.object({}),
    async run() {
      failingTool();
      return {};
    },
  });
  const lease = new CredentialRegistry(() => "c".repeat(64)).issue(
    McpScope.parse({
      sessionId: "session",
      threadId: "reading-thread",
      agentId: "root",
      capabilities: [],
    }),
    new AbortController().signal,
  );
  try {
    const result = await registry.call("thread_read", {}, lease.principal, new AbortController().signal);
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/cannot read|secret-plan|TypeError|failingTool/);
    const first = result.content[0];
    const failure = Failure.parse(JSON.parse(first?.type === "text" ? first.text : "null"));
    expect(failure).toMatchObject({ code: "execution_failed", errorId: "failure-1" });

    const lines = log.recent().filter((line) => line.includes("Tool failed"));
    expect(lines).toHaveLength(1);
    const record = z
      .object({
        data: z.object({
          errorId: z.string(),
          tool: z.string(),
          threadId: z.string(),
          errorName: z.string(),
          stack: z.string(),
          error: z.object({ message: z.string() }),
        }),
      })
      .parse(JSON.parse(lines[0] ?? "null"));
    expect(record.data).toMatchObject({
      errorId: failure.errorId,
      tool: "thread_read",
      threadId: "reading-thread",
      errorName: "TypeError",
      error: { message: expect.stringContaining("cannot read rows of undefined") },
    });
    expect(record.data.stack).toMatch(/at failingTool .*tool-failure-log\.test\.ts/);
  } finally {
    lease.end();
    await log.close();
  }
});
