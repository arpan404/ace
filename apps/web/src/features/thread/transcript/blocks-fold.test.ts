import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { blockItems, buildBlocks, type BlockSource, type RunFacts } from "./blocks.ts";

/*
 * A finished turn folds into its "Worked for" head; a working one says so under its ask.
 */

function message(id: string, role: "user" | "assistant", at: number, run?: string) {
  return Item.parse({
    id,
    agentId: "root",
    createdAt: at,
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text: id }],
    ...(run ? { runId: run } : {}),
    ...(role === "user" ? { origin: { kind: "person", commandId: `send-${id}` } } : {}),
  });
}
function shell(id: string, at: number, run: string) {
  return Item.parse({
    id,
    agentId: "root",
    runId: run,
    createdAt: at,
    complete: true,
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind: "shell",
      title: id,
      detail: { kind: "shell", command: id },
      status: "succeeded",
      startedAt: at,
      raw: [],
    },
  });
}
function error(id: string, at: number, run: string) {
  return Item.parse({
    id,
    agentId: "root",
    runId: run,
    createdAt: at,
    complete: true,
    type: "notice",
    level: "error",
    text: "The build broke twice before it passed",
  });
}

function source(items: Item[], run: RunFacts): BlockSource {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  return {
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(),
    turnOf: (id) => byId.get(id)?.runId,
    run: (id) => (id === "turn" ? run : undefined),
  };
}

const turn = [
  message("ask", "user", 1),
  shell("install", 2, "turn"),
  message("progress", "assistant", 3, "turn"),
  shell("build", 4, "turn"),
  error("broke", 5, "turn"),
  message("answer", "assistant", 6, "turn"),
];

// Mutations: leaving work in view after the turn settled, or folding the answer or a failure.
test("a completed turn folds its work behind one head; its answer and failures stay in view", () => {
  const blocks = buildBlocks(
    source(turn, { state: "completed", trigger: "user", startedAt: 1, endedAt: 7 }),
  );
  expect(blocks.map((block) => block.kind)).toEqual(["user", "work", "item", "message"]);
  const head = blocks[1];
  expect(head?.kind === "work" && head.outcome).toBe("completed");
  expect(head?.kind === "work" && head.answerIds).toEqual(["answer"]);
  // A jump to a folded step still finds the head that holds it.
  expect(head && blockItems(head)).toEqual(
    expect.arrayContaining(["install", "progress", "build"]),
  );
  expect(blocks[3]?.kind === "message" && blocks[3].itemId).toBe("answer");
});

test("a completed turn's own notice stays where it happened, outside the fold", () => {
  const warning = Item.parse({
    id: "restarted",
    agentId: "root",
    runId: "turn",
    createdAt: 3,
    complete: true,
    type: "notice",
    level: "warning",
    text: "The provider restarted",
  });
  const blocks = buildBlocks(
    source([...turn.slice(0, 2), warning, ...turn.slice(3, 4), ...turn.slice(5)], {
      state: "completed",
      trigger: "user",
      startedAt: 1,
      endedAt: 7,
    }),
  );
  expect(blocks.some((block) => block.kind === "item" && block.itemId === "restarted")).toBe(true);
  const head = blocks.find((block) => block.kind === "work");
  expect(head?.kind === "work" && head.folded?.flatMap(blockItems)).not.toContain("restarted");
});

test("a failed turn keeps everything it did in view", () => {
  const blocks = buildBlocks(
    source(turn, { state: "failed", trigger: "user", startedAt: 1, endedAt: 7 }),
  );
  const head = blocks.find((block) => block.kind === "work");
  expect(head?.kind === "work" && head.folded).toBeUndefined();
});

// Mutations: putting the live line after the turn's work, adding a second one, or keeping it
// after the turn settles.
test("a working turn has one live line, right under its ask where its Worked for will stand", () => {
  const working = buildBlocks(source(turn.slice(0, 4), { state: "active", trigger: "user" }));
  expect(working.filter((block) => block.kind === "live")).toHaveLength(1);
  expect(working[0]?.kind).toBe("user");
  const live = working[1];
  expect(live?.kind === "live" && live.askId).toBe("ask");
  expect(working.length).toBeGreaterThan(2);
  const done = buildBlocks(
    source(turn, { state: "completed", trigger: "user", startedAt: 1, endedAt: 7 }),
  );
  expect(done.some((block) => block.kind === "live")).toBe(false);
});

// Mutation: folding all but the last of an answer given in several messages.
test("an answer said in several messages after the last step stays whole", () => {
  const blocks = buildBlocks(
    source(
      [
        message("ask", "user", 1),
        shell("build", 2, "turn"),
        message("found", "assistant", 3, "turn"),
        message("fixed", "assistant", 4, "turn"),
      ],
      { state: "completed", trigger: "user", startedAt: 1, endedAt: 7 },
    ),
  );
  expect(blocks.map((block) => ("itemId" in block ? block.itemId : block.kind))).toEqual([
    "ask",
    "work",
    "found",
    "fixed",
  ]);
  const head = blocks[1];
  expect(head?.kind === "work" && head.answerIds).toEqual(["found", "fixed"]);
});

// Mutation: opening a second "Worked for" log for a run the daemon numbers into the same turn.
test("a run ace continued after a restart folds into the ask's one log when it shares its turn", () => {
  const items = [
    message("ask", "user", 1),
    shell("install", 2, "first"),
    shell("build", 4, "continued"),
    message("answer", "assistant", 5, "continued"),
  ];
  const runs = new Map<string, RunFacts>([
    ["first", { state: "interrupted", trigger: "user", turn: 1, startedAt: 1, endedAt: 3 }],
    ["continued", { state: "completed", trigger: "restart", turn: 1, startedAt: 4, endedAt: 6 }],
  ]);
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  const blocks = buildBlocks({
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(),
    turnOf: (id) => byId.get(id)?.runId,
    run: (id) => runs.get(id),
  });
  expect(blocks.filter((block) => block.kind === "work")).toHaveLength(1);
});
