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
  expect(head?.kind === "work" && head.answerId).toBe("answer");
  // A jump to a folded step still finds the head that holds it.
  expect(head && blockItems(head)).toEqual(
    expect.arrayContaining(["install", "progress", "build"]),
  );
  expect(blocks[3]?.kind === "message" && blocks[3].itemId).toBe("answer");
});

test("a failed turn keeps everything it did in view", () => {
  const blocks = buildBlocks(
    source(turn, { state: "failed", trigger: "user", startedAt: 1, endedAt: 7 }),
  );
  const head = blocks.find((block) => block.kind === "work");
  expect(head?.kind === "work" && head.folded).toBeUndefined();
});

// Mutations: putting the live header at the end, or keeping it after the turn settles.
test("a working turn's live header sits right under its ask, above everything it did", () => {
  const working = buildBlocks(source(turn.slice(0, 4), { state: "active", trigger: "user" }));
  expect(working.map((block) => block.kind).slice(0, 3)).toEqual(["user", "live", "work"]);
  const live = working[1];
  expect(live?.kind === "live" && live.askId).toBe("ask");
  const done = buildBlocks(
    source(turn, { state: "completed", trigger: "user", startedAt: 1, endedAt: 7 }),
  );
  expect(done.some((block) => block.kind === "live")).toBe(false);
});
