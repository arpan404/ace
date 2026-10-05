import { expect, it } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { browserToolkit } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import { TestNavigationClock } from "./navigation-test-clock.ts";

it("the public MCP navigation remains live for a 60-second approval instead of aborting at 35 seconds", async () => {
  const clock = new TestNavigationClock();
  const entered = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<boolean>();
  const f = await backendFixture({
    navigationClock: clock,
    origins: { list: () => [], grant() {}, revoke() {} },
    originPolicy: () => {
      entered.resolve();
      return approval.promise;
    },
    backendPreference: () => "headless",
  });
  await f.open();
  const registry = new ToolRegistry({
    scheduler: { after: (delay, work) => clock.set(delay, work) },
  });
  browserToolkit(f.service).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "provider",
      threadId: "thread",
      agentId: "root",
      capabilities: ["browser"],
    }),
    new AbortController().signal,
  );
  try {
    const call = registry.call(
      "ace_browser_navigate",
      { url: "https://approved.example/" },
      lease.principal,
      new AbortController().signal,
    );
    await entered.promise;
    clock.advance(60_000);
    approval.resolve(true);
    expect(await call).not.toHaveProperty("isError", true);
    expect(f.service.state("thread").url).toBe("https://approved.example/");
  } finally {
    credentials.close();
  }
});
