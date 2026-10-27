import { Item, Run } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  bringBackOf,
  bringBackWaits,
  editPointOf,
  mergeAnswerOf,
  mergeSummaryOf,
  retryPointOf,
} from "./edit-point.ts";

const message = (
  id: string,
  role: "user" | "assistant",
  runId: string,
  extra: { complete?: boolean; nativeId?: string; agentId?: string } = {},
) =>
  Item.parse({
    id,
    agentId: extra.agentId ?? "root",
    runId,
    createdAt: 1,
    type: "message",
    role,
    complete: extra.complete ?? true,
    ...(extra.nativeId ? { nativeId: extra.nativeId } : {}),
    parts: [{ type: "text", text: id }],
  });
const run = (id: string, state: Run["state"]) =>
  Run.parse({ id, threadId: "t", agentId: "root", trigger: "user", state, startedAt: 1 });

function reader(items: Item[], runs: Run[]) {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  const byRun = new Map<string, Run>(runs.map((each) => [each.id, each]));
  return {
    order: items.map((item) => item.id),
    item: (id: string) => byId.get(id),
    run: (id: string) => byRun.get(id),
  };
}

const thread = reader(
  [
    message("ask-1", "user", "r1"),
    message("answer-1", "assistant", "r1", { nativeId: "entry-1" }),
    message("ask-2", "user", "r2"),
    message("sub-answer", "assistant", "r3", { agentId: "child" }),
    message("answer-2", "assistant", "r2", { nativeId: "entry-2" }),
  ],
  [run("r1", "completed"), run("r2", "completed"), run("r3", "completed")],
);

test("only the newest answer retries, by asking its ask again from before that ask", () => {
  expect(retryPointOf(thread, "answer-2", "root")).toEqual({
    askId: "ask-2",
    point: { fork: { type: "turn", runId: "r1" }, piEntry: "entry-1" },
  });
  expect(retryPointOf(thread, "answer-1", "root")).toBeUndefined();
  expect(retryPointOf(thread, "sub-answer", "root")).toBeUndefined();
});

test("an answer still being written, or one the person already replied to, doesn't retry", () => {
  const writing = reader(
    [
      message("ask-1", "user", "r1"),
      message("answer-1", "assistant", "r1"),
      message("ask-2", "user", "r2"),
      message("answer-2", "assistant", "r2", { complete: false }),
    ],
    [run("r1", "completed"), run("r2", "active")],
  );
  expect(retryPointOf(writing, "answer-2", "root")).toBeUndefined();
  const replied = reader(
    [
      message("ask-1", "user", "r1"),
      message("answer-1", "assistant", "r1"),
      message("ask-2", "user", "r2"),
    ],
    [run("r1", "completed")],
  );
  expect(retryPointOf(replied, "answer-1", "root")).toBeUndefined();
});

test("editing a later message forks from the answer before it; the opening message can't be edited", () => {
  expect(editPointOf(thread, "ask-2", "root", 2)).toEqual({
    fork: { type: "turn", runId: "r1" },
    piEntry: "entry-1",
  });
  expect(editPointOf(thread, "ask-1", "root", 0)).toBeUndefined();
  expect(editPointOf(thread, "answer-1", "root", 1)).toBeUndefined();
});

test("a message steered into a running turn edits from the last finished turn before it", () => {
  const steered = reader(
    [
      message("ask-1", "user", "r1"),
      message("answer-1", "assistant", "r1"),
      message("ask-2", "user", "r2"),
      message("partial", "assistant", "r2", { complete: false }),
      message("steer", "user", "r2"),
    ],
    [run("r1", "completed"), run("r2", "active")],
  );
  expect(editPointOf(steered, "steer", "root", 4)?.fork).toEqual({ type: "turn", runId: "r1" });
});

test("a fork brings back its own newest answer, never what it copied from its parent", () => {
  const copied = Item.parse({
    ...message("copied", "assistant", "r0"),
    inherited: { threadId: "parent" },
  });
  const fork = reader(
    [copied, message("ask", "user", "r1"), message("own", "assistant", "r1")],
    [run("r1", "completed")],
  );
  expect(mergeAnswerOf(fork, "root")?.id).toBe("own");
  expect(mergeSummaryOf(mergeAnswerOf(fork, "root"), 2)).toBe("ow");
  const fresh = reader([copied], []);
  expect(mergeAnswerOf(fresh, "root")).toBeUndefined();
});

test("a fork whose tree still works can't be brought back; a finished one with its own answer can", () => {
  const fork = reader(
    [message("ask", "user", "r1"), message("own", "assistant", "r1")],
    [run("r1", "completed")],
  );
  expect(bringBackOf(fork, "root", "working")).toEqual({ refused: bringBackWaits.working });
  expect(bringBackOf(fork, "root", "needs_you")).toEqual({ refused: bringBackWaits.working });
  expect(bringBackOf(fork, "root", "done")).toMatchObject({ answer: { id: "own" } });
  const empty = reader([message("ask", "user", "r1")], [run("r1", "completed")]);
  expect(bringBackOf(empty, "root", "done")).toEqual({ refused: bringBackWaits.answer });
});
