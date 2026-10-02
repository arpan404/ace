import { expect, it } from "vitest";
import { harness } from "./test-helper.ts";
import type { ThreadState } from "./index.ts";

it("rejection before root discovery waits for the root without publishing a diagnostics agent", () => {
  const h = harness();
  const fact = { type: "usage", agent: "stray", inputTokens: -1, outputTokens: 0 };
  expect(h.send(fact, 100)).toEqual([]);
  expect(h.view.status).toEqual({ state: "new" });
  expect(Object.values(h.view.agents)).toHaveLength(0);
  expect(h.send({ type: "tick" }, 10_000)).toEqual([]);
  const events = h.see();
  expect(Object.values(h.view.agents)).toHaveLength(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "item.created",
      item: expect.objectContaining({
        type: "notice",
        level: "warning",
        agentId: h.agent("root")!.id,
        createdAt: 100,
        raw: [{ type: "core.rejected_fact", data: fact }],
      }),
    }),
  );
  h.start();
  h.end();
  expect(h.view.status).toEqual({ state: "done" });
  expect(Object.values(h.view.agents)).toHaveLength(1);
});

it("deferred rejection warnings survive snapshots and preserve the first valid item's identity", () => {
  const h = harness();
  const facts = [
    { type: "provider.future", raw: "first" },
    { type: "usage", agent: "stray", inputTokens: -1, outputTokens: 0 },
  ];
  for (const [index, fact] of facts.entries()) expect(h.send(fact, 100 + index)).toEqual([]);
  const restored: ThreadState = JSON.parse(JSON.stringify(h.state));
  const events = h.send(
    {
      type: "item.upsert",
      agent: "root",
      item: "valid",
      draft: {
        type: "message",
        parts: [{ type: "text", text: "First valid item" }],
        complete: true,
      },
    },
    200,
    restored,
  );
  expect(h.item("valid")).toMatchObject({
    type: "message",
    parts: [{ type: "text", text: "First valid item" }],
  });
  const notices = events.flatMap((event) =>
    event.type === "item.created" && event.item.type === "notice" ? [event.item] : [],
  );
  expect(notices.map((notice) => notice.raw?.[0]?.data)).toEqual(facts);
  expect(notices.map((notice) => notice.createdAt)).toEqual([100, 101]);
  expect(
    notices.every((notice) => notice.agentId === h.agent("root")!.id && notice.runId === undefined),
  ).toBe(true);
  expect(
    h
      .send({ type: "signal", agent: "root" }, 201, restored)
      .filter((event) => event.type === "item.created"),
  ).toEqual([]);
});
