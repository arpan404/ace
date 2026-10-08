import { AgentId } from "@ace/protocol";
import { expect, test } from "vitest";
import { contextUsage, queueMoveAfter, queueNotice } from "./queue.ts";

const now = new Date("2026-10-01T15:00:00").getTime();
const reset = new Date("2026-10-01T17:30:00").getTime();
const flowing = { paused: false, reason: null, resumeAt: null };
const ids = (notice: ReturnType<typeof queueNotice>) => notice?.actions.map((a) => a.id);

test("a flowing queue says nothing", () => {
  expect(queueNotice({ state: "working", agents: 1 }, flowing, now)).toBeUndefined();
});

test("a usage limit with a known reset offers resume at reset, snooze, another account and now", () => {
  const notice = queueNotice({ state: "limited", until: reset }, flowing, now, "en-US");
  expect(notice?.title).toBe("Usage limit reached");
  expect(notice?.detail).toContain("5:30 PM");
  expect(ids(notice)).toEqual([
    "resume_at_reset",
    "snooze_until_reset",
    "migrate_now",
    "resume_now",
  ]);
});

test("without a reset time the timed choices are not offered", () => {
  const notice = queueNotice(
    { state: "limited" },
    { paused: true, reason: "limit", resumeAt: null },
    now,
  );
  expect(ids(notice)).toEqual(["migrate_now", "resume_now"]);
  expect(notice?.detail).toContain("didn't say");
});

test("a timer to resume at reset says when, and can be called off", () => {
  const notice = queueNotice(
    { state: "limited", until: reset },
    { paused: true, reason: "limit", resumeAt: reset },
    now,
    "en-US",
  );
  expect(notice?.kind).toBe("resuming");
  expect(notice?.detail).toContain("5:30 PM");
  expect(ids(notice)).toEqual(["resume_now", "hold"]);
});

test("a snooze, a restart, an uncertain delivery and a manual pause each explain themselves", () => {
  expect(
    queueNotice(undefined, { paused: true, reason: "snooze", resumeAt: reset }, now)?.kind,
  ).toBe("snoozed");
  expect(
    ids(queueNotice(undefined, { paused: true, reason: "restart", resumeAt: null }, now)),
  ).toEqual(["resume"]);
  expect(
    ids(queueNotice(undefined, { paused: true, reason: "uncertain", resumeAt: null }, now)),
  ).toEqual([]);
  expect(
    queueNotice(undefined, { paused: true, reason: "manual", resumeAt: null }, now)?.title,
  ).toBe("Queue paused");
});

test("context usage is a share of the window, or a token count when the window is unknown", () => {
  const meter = { agentId: AgentId.parse("a"), epoch: 1, source: "provider" as const };
  expect(contextUsage({ ...meter, usedTokens: 168_000, windowTokens: 200_000 }, "en-US")).toEqual({
    percent: 84,
    short: "84%",
    long: "168,000 of 200,000 tokens in context",
    high: true,
  });
  expect(contextUsage({ ...meter, usedTokens: 12_400, windowTokens: null })?.short).toBe(
    "12k tokens",
  );
  expect(contextUsage({ ...meter, usedTokens: null, windowTokens: 200_000 })).toBeUndefined();
});

test("moving a queued message names the one it goes after, or the front", () => {
  const order = ["a", "b", "c"];
  expect(queueMoveAfter(order, 1, -1)).toBeNull();
  expect(queueMoveAfter(order, 2, -1)).toBe("a");
  expect(queueMoveAfter(order, 0, 1)).toBe("b");
  expect(queueMoveAfter(order, 0, -1)).toBeUndefined();
  expect(queueMoveAfter(order, 2, 1)).toBeUndefined();
});

test("a missing model replaces restart continuation with one model-picking action", () => {
  const notice = queueNotice(
    { state: "waiting", on: "queue" },
    { paused: true, reason: "restart", resumeAt: null },
    now,
    undefined,
    undefined,
    { provider: "opencode", model: "opencode-go/muse-spark-1.3-contributor" },
  );
  expect(notice?.title).toBe(
    "Muse Spark 1.3 Contributor isn't available in OpenCode anymore — pick another model",
  );
  expect(ids(notice)).toEqual(["choose_model"]);
});

test("a kept pre-delivery failure offers retry while a restart offers continuation", () => {
  expect(
    queueNotice(
      { state: "waiting", on: "queue" },
      { paused: true, reason: "not_sent", resumeAt: null },
      now,
    ),
  ).toMatchObject({ title: "Message not sent", actions: [{ id: "resume", label: "Try again" }] });
});
