import { expect, test } from "vitest";
import { apply, createThreadState, type Fact } from "@ace/core";
import { ThreadCatchUpRequest, TurnsPageRequest } from "@ace/protocol";
import { storeFixture } from "./long-thread-test-support.ts";

test("a never-started silent diagnostic stays visible while completed turns settle across reload", async () => {
  const h = storeFixture();
  const state = createThreadState({
    threadId: h.thread.id,
    config: { provider: "codex", silenceMs: 100 },
  });
  let serial = 0;
  const feed = (fact: Fact, now: number) =>
    h.store.appendEvents(
      h.thread.id,
      apply(state, fact, { now, ids: { next: () => `diagnostic-${++serial}` } }),
      now,
    );
  feed(
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex" },
      cwd: h.home,
    },
    101,
  );
  feed({ type: "turn.started", agent: "root", trigger: "user" }, 102);
  feed({ type: "turn.ended", agent: "root", outcome: "completed" }, 103);
  feed({ type: "usage", agent: "stray", inputTokens: 1, outputTokens: 0 }, 200);
  feed({ type: "tick" }, 301);
  const assertFinished = (count: number) => {
    expect(h.store.getThread(h.thread.id)?.status.state).toBe("done");
    const turns = h.store.turnsPage(
      TurnsPageRequest.parse({
        type: "turns.page",
        requestId: "turns",
        threadId: h.thread.id,
        limit: 10,
      }),
    );
    expect(turns.turns).toHaveLength(count);
    expect(
      turns.turns.every((turn) => turn.status.state === "done" && turn.endedAt !== undefined),
    ).toBe(true);
    expect(turns.turns.find((turn) => turn.ordinal === 1)?.subagents).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: { state: "unresponsive" } })]),
    );
    const catchUp = h.store.threadCatchUp(
      ThreadCatchUpRequest.parse({
        type: "thread.catchUp",
        requestId: "catch-up",
        threadId: h.thread.id,
        sinceSeq: 0,
      }),
    );
    expect(catchUp.turnsCompleted).toBe(count);
  };
  assertFinished(1);
  await h.restart();
  assertFinished(1);
  feed({ type: "turn.started", agent: "root", trigger: "user" }, 400);
  feed({ type: "turn.ended", agent: "root", outcome: "completed" }, 401);
  assertFinished(2);
});
