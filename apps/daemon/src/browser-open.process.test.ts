import { expect, it, onTestFinished } from "vitest";
import { AgentId } from "@ace/protocol";
import { setup, invoke, Result } from "./browser-mcp-test-support.ts";
it("ace_browser_open can be retried in the same thread without switching browser backends", async () => {
  const f = await setup("codex");
  const lease = f.mcp.openSession(
    {
      sessionId: "open",
      threadId: f.thread.id,
      agentId: AgentId.parse("root"),
      capabilities: ["browser"],
    },
    new AbortController().signal,
  );
  onTestFinished(lease.end);
  const connection = { url: f.mcp.url, bearer: lease.bearer };
  for (const url of ["http://localhost:3000/first", "http://localhost:3000/retry"]) {
    const result = Result.parse(
      await (await invoke(connection, "ace_browser_open", { url })).json(),
    ).result;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(f.browser.state(f.thread.id)).toMatchObject({ backend: "headless", url });
  }
});
