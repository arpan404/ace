import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

test("Codex RPC receipts and handled lifecycle events never become transcript notices", () => {
  const h = setup();
  h.send("initialize", {}, 1);
  h.feed({ seq: 100, t: 100, dir: "recv", channel: "stdio", data: { id: 1, result: {} } });
  h.start();
  h.recv("thread/tokenUsage/updated", {
    threadId: "native",
    tokenUsage: { last: { totalTokens: 12, inputTokens: 10, outputTokens: 2 } },
  });
  h.end();
  expect(Object.values(h.state.items).filter((item) => item.type === "notice")).toEqual([]);
  expect(h.state.status.state).toBe("done");
});

for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
  test(`Codex ${method} confirms the actual model and settings replace it for usage and context`, () => {
    const h = setup();
    h.send(method, { cwd: "/repo", model: "requested-alias" }, 1);
    h.feed({
      seq: 100,
      t: 100,
      dir: "recv",
      channel: "stdio",
      data: { id: 1, result: { thread: { id: "native", cwd: "/repo" }, model: "actual-A" } },
    });
    expect(h.state.agents.root?.agent.model).toBe("actual-A");
    h.recv("thread/settings/updated", { threadId: "native", model: "actual-B" });
    h.recv("thread/tokenUsage/updated", {
      threadId: "native",
      tokenUsage: {
        last: { totalTokens: 12, inputTokens: 10, outputTokens: 2 },
        modelContextWindow: 200000,
      },
    });
    expect(h.state.agents.root?.agent.model).toBe("actual-B");
    expect(h.events.filter((e) => e.type === "context.sampled")).toMatchObject([
      { model: "actual-B", usedTokens: 12 },
    ]);
    expect(h.events.filter((e) => e.type === "usage.updated")).toMatchObject([
      { model: "actual-B", inputTokens: 10, outputTokens: 2 },
    ]);
  });
}
