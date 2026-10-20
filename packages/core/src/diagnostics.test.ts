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
  expect(
    notices.map((notice) => {
      const raw = notice.raw[0];
      return raw && "data" in raw ? raw.data : undefined;
    }),
  ).toEqual(facts);
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

const rejectionNotices = (h: ReturnType<typeof harness>) =>
  Object.values(h.view.items).flatMap((item) =>
    item.type === "notice" && item.raw.some((raw) => raw.type === "core.rejected_fact")
      ? [item]
      : [],
  );
/** A child claiming the root's pending approval; each attempt differs only in its raw data. */
const stray = (index: number) => ({
  type: "interaction.opened",
  agent: "child",
  interaction: "approval",
  blocking: true,
  request: { kind: "question", questions: [], attempt: index },
});

it("repeated identical rejected facts show one notice that counts them", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("child", "root");
  h.question("approval", "root");
  for (let index = 0; index < 30; index++) h.send(stray(index));
  const [notice, ...others] = rejectionNotices(h);
  expect(others).toEqual([]);
  expect(notice).toMatchObject({
    text: "Ignored adapter fact: live key has a different owner (30 times)",
  });
  // The first occurrences keep their raw facts; the count covers the rest.
  expect(notice?.raw.slice(0, 2)).toEqual([
    { type: "core.rejected_fact", data: stray(0) },
    { type: "core.rejected_fact", data: stray(1) },
  ]);
  expect(h.view.status).toEqual({ state: "needs_you", interactions: 1 });
});

it("different rejections and a later root run each get their own notice", () => {
  const h = harness();
  h.see();
  h.start();
  const negativeUsage = { type: "usage", agent: "root", inputTokens: -1, outputTokens: 0 };
  h.send(negativeUsage);
  h.send({ type: "provider.future", agent: "root" });
  h.send(negativeUsage);
  expect(rejectionNotices(h)).toHaveLength(2);
  h.end();
  h.start("root", "second-turn");
  h.send(negativeUsage);
  expect(rejectionNotices(h)).toHaveLength(3);
});
