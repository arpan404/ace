import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { buildBlocks, type Block, type BlockSource, type RunFacts } from "./blocks.ts";

/*
 * A question waits as its own line where it was asked; once closed, its step is the turn's work.
 */

function ask(at: number) {
  return Item.parse({
    id: "ask",
    agentId: "root",
    createdAt: at,
    complete: true,
    type: "message",
    role: "user",
    parts: [{ type: "text", text: "Set up the formatter" }],
    origin: { kind: "person", commandId: "send-ask" },
  });
}
function call(
  id: string,
  at: number,
  detail: { kind: "shell"; command: string } | { kind: "ask_user" },
) {
  return Item.parse({
    id,
    agentId: "root",
    runId: "turn",
    createdAt: at,
    complete: true,
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind: detail.kind,
      title: id,
      detail,
      status: "succeeded",
      startedAt: at,
      raw: [],
    },
  });
}
const answer = Item.parse({
  id: "answer",
  agentId: "root",
  runId: "turn",
  createdAt: 9,
  complete: true,
  type: "message",
  role: "assistant",
  parts: [{ type: "text", text: "Done." }],
});

function source(
  items: Item[],
  run: RunFacts,
  question: { toolCallId?: string; open: boolean },
): BlockSource {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  return {
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(),
    turnOf: (id) => byId.get(id)?.runId,
    run: (id) => (id === "turn" ? run : undefined),
    questions: [{ id: "q", toolCallId: question.toolCallId, createdAt: 4, kind: "question" }],
    questionOpen: () => question.open,
  };
}

const working: RunFacts = { state: "active", trigger: "user", startedAt: 1 };
const completed: RunFacts = { state: "completed", trigger: "user", startedAt: 1, endedAt: 10 };
const items = [
  ask(1),
  call("read", 2, { kind: "shell", command: "cat package.json" }),
  call("asked", 3, { kind: "ask_user" }),
  call("edit", 5, { kind: "shell", command: "bun fmt" }),
];

const logged = (blocks: readonly Block[]) =>
  blocks.flatMap((block) => (block.kind === "work" ? block.itemIds : []));

// Mutation: folding a waiting question into the log, or leaving its step in the log as well.
test("a waiting question stands in for its step as its own line, outside the work log", () => {
  const blocks = buildBlocks(source(items, working, { toolCallId: "asked", open: true }));
  const question = blocks.find((block) => block.kind === "question");
  expect(question?.kind === "question" && question.itemId).toBe("asked");
  expect(logged(blocks)).toEqual(["read", "edit"]);
});

// Mutation: keeping the line once the question closed, or dropping its step.
test("once answered, the question's step reads in the work log, in order, with no line of its own", () => {
  const blocks = buildBlocks(source(items, working, { toolCallId: "asked", open: false }));
  expect(blocks.some((block) => block.kind === "question")).toBe(false);
  expect(logged(blocks)).toEqual(["read", "asked", "edit"]);
});

// Mutation: leaving a closed question in view of a completed turn, or folding a waiting one.
test("a completed turn folds a closed question with no step in view, and never a waiting one", () => {
  const unanchored = [...items.filter((item) => item.id !== "asked"), answer];
  const closed = buildBlocks(source(unanchored, completed, { open: false }));
  expect(closed.map((block) => block.kind)).toEqual(["user", "work", "message"]);
  const head = closed.find((block) => block.kind === "work");
  expect(head?.kind === "work" && head.folded?.map((block) => block.kind)).toContain("question");

  const open = buildBlocks(source(unanchored, completed, { open: true }));
  expect(open.map((block) => block.kind)).toContain("question");
});
