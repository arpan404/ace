import { Item, Run } from "@ace/protocol";
import { expect, test } from "vitest";
import { forkPointOf, latestForkPoint } from "./fork-point.ts";

const answer = (id: string, runId: string | undefined, complete = true, agentId = "root") =>
  Item.parse({
    id,
    threadId: "t",
    agentId,
    ...(runId ? { runId } : {}),
    createdAt: 1,
    updatedAt: 1,
    type: "message",
    role: "assistant",
    complete,
    parts: [{ type: "text", text: "Done." }],
  });
const run = (id: string, state: Run["state"]) =>
  Run.parse({ id, threadId: "t", agentId: "root", trigger: "user", state, startedAt: 1 });

test("a finished turn forks from that turn, whatever its outcome", () => {
  expect(forkPointOf(answer("a", "r1"), run("r1", "interrupted"))).toEqual({
    type: "turn",
    runId: "r1",
  });
  expect(forkPointOf(answer("a", "r1"), run("r1", "active"))).toBeUndefined();
});

test("an answer still streaming can't be forked; one without a turn forks at the message", () => {
  expect(forkPointOf(answer("a", "r1", false), run("r1", "completed"))).toBeUndefined();
  expect(forkPointOf(answer("a", undefined), undefined)).toEqual({ type: "item", itemId: "a" });
});

test("the thread menu forks from the main agent's newest finished answer", () => {
  const items = new Map([
    ["old", answer("old", "r1")],
    ["sub", answer("sub", "r3", true, "child")],
    ["live", answer("live", "r2")],
  ]);
  const runs = new Map([
    ["r1", run("r1", "completed")],
    ["r2", run("r2", "active")],
    ["r3", run("r3", "completed")],
  ]);
  const reader = {
    order: ["old", "sub", "live"],
    item: (id: string) => items.get(id),
    run: (id: string) => runs.get(id),
  };
  expect(latestForkPoint(reader, "root")).toEqual({ type: "turn", runId: "r1" });
  expect(latestForkPoint({ ...reader, order: [] }, "root")).toBeUndefined();
});
