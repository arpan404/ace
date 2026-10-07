import { expect, it, onTestFinished } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { manager, ready, target } from "./testing/support.ts";
import { screenToolkit } from "./index.ts";
const options = { observeMs: 2000, repeat: 1, filmstrip: false };
it("repeat capture counts native input preparation toward its twenty-second budget", async () => {
  const h = await manager({ FAKE_V2: "1", MEASUREMENT_PREPARATION: "1" });
  onTestFinished(h.close);
  const session = await ready(h.screen);
  h.screen.controller(session.sessionId, "agent", "agent");
  const result = await h.screen.measureInteraction(
    session.sessionId,
    { ...options, observeMs: 4000, repeat: 5, action: { kind: "text.type", text: "x" } },
    "agent",
    new AbortController().signal,
  );
  expect(result.repeat?.runs.map((run) => run.verdict)).toEqual([
    "smooth",
    "smooth",
    "smooth",
    "smooth",
    "inconclusive",
  ]);
  expect(result.repeat?.metrics.windowMs).toEqual({ median: 4250, worst: 4250 });
  expect(result.windowMs).toBe(3000);
  expect(result.verdict).toBe("inconclusive");
  expect((await h.screen.targets()).windows[0]?.title).toContain("actions:5");
});
it("observation measures approved pixels without Accessibility or controller permission", async () => {
  const h = await manager({ FAKE_V2: "1", ACCESS_DENIED: "1" });
  onTestFinished(h.close);
  const session = await ready(h.screen);
  const result = await h.screen.measureInteraction(
    session.sessionId,
    options,
    "viewer",
    new AbortController().signal,
  );
  expect(result.source).toBe("screen-frames");
  expect(result.verdict).toBe("smooth");
  expect(result.frames).toBe(60);
  expect(result.latencyMs).toBeUndefined();
  expect(h.screen.state(session.sessionId).indicator).toBe(false);
  await expect(
    h.screen.measureInteraction(
      session.sessionId,
      { ...options, action: { kind: "text.type", text: "hello" } },
      "viewer",
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it("repeated measured input runs through controller checks and performs each input", async () => {
  const h = await manager({ FAKE_V2: "1" });
  onTestFinished(h.close);
  const session = await ready(h.screen);
  h.screen.controller(session.sessionId, "agent", "agent");
  const result = await h.screen.measureInteraction(
    session.sessionId,
    { ...options, repeat: 2, filmstrip: true, action: { kind: "text.type", text: "x" } },
    "agent",
    new AbortController().signal,
  );
  expect(result.repeat?.runs.map((run) => run.verdict)).toEqual(["smooth", "smooth"]);
  expect(result.filmstrip?.type).toBe("image");
  const found = await h.screen.uiFind(
    session.sessionId,
    { query: { name: "Typed text" } },
    "agent",
  );
  expect(JSON.stringify(found)).toContain("xx");
  expect((await h.screen.targets()).windows[0]?.title).toContain("actions:2");
  h.screen.controller(session.sessionId, "human", "person");
  await expect(
    h.screen.measureInteraction(
      session.sessionId,
      { ...options, action: { kind: "text.type", text: "wrong" } },
      "agent",
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it("revoked app grants and excessive capture budgets reject measurement", async () => {
  const h = await manager({ FAKE_V2: "1" });
  onTestFinished(h.close);
  const session = await ready(h.screen);
  for (const input of [
    { ...options, observeMs: 10001 },
    { ...options, repeat: 6 },
    { ...options, observeMs: 5000, repeat: 5 },
  ])
    await expect(
      h.screen.measureInteraction(session.sessionId, input, "viewer", new AbortController().signal),
    ).rejects.toThrow();
  await h.screen.approve(target.bundleId, false);
  await expect(
    h.screen.measureInteraction(session.sessionId, options, "viewer", new AbortController().signal),
  ).rejects.toThrow();
});
it("measurement MCP actions request view permission only when no input is supplied", async () => {
  const h = await manager({ FAKE_V2: "1" });
  onTestFinished(h.close);
  await ready(h.screen);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "b".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "test",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  expect(registry.action("screen_measure_interaction", {})).toMatchObject({
    access: "read",
    riskClass: "read-only",
  });
  expect(
    registry.action("screen_measure_interaction", { action: { kind: "text.type", text: "hello" } }),
  ).toMatchObject({ access: "write", riskClass: "external-effect" });
  expect(registry.action("screen_measure_interaction", { observeMs: 10001 })).toBeUndefined();
  expect(registry.action("screen_measure_interaction", { repeat: 6 })).toBeUndefined();
  expect(
    registry.list(lease.principal).find((tool) => tool.name === "screen_measure_interaction")
      ?.inputSchema,
  ).toMatchObject({ properties: { observeMs: { maximum: 10000 }, repeat: { maximum: 5 } } });
});
