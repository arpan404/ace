import { BackgroundTask, Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { blockItems, buildBlocks, type Block, type BlockSource, type RunFacts } from "./blocks.ts";

/*
 * A background task is a step of its turn's tool work: its row sits where its call started, and
 * everything the agent does after it reads below it, in order. Ending later updates the row in
 * place; it never pins to the bottom of the turn or moves later work above it (#1180).
 */

let clock = 0;
const message = (id: string, role: "user" | "assistant") =>
  Item.parse({
    id,
    agentId: "root",
    runId: "run",
    createdAt: ++clock,
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text: id }],
  });
const thought = (id: string) =>
  Item.parse({
    id,
    agentId: "root",
    runId: "run",
    createdAt: ++clock,
    complete: true,
    type: "reasoning",
    text: `Thinking about ${id}`,
  });
const shell = (id: string) =>
  Item.parse({
    id,
    agentId: "root",
    runId: "run",
    createdAt: ++clock,
    complete: true,
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind: "shell",
      title: id,
      detail: { kind: "shell", command: `run ${id}` },
      status: "succeeded",
      startedAt: clock,
      raw: [],
    },
  });
const task = (id: string, status: BackgroundTask["status"], endedAt?: number) =>
  BackgroundTask.parse({
    id,
    agentId: "root",
    kind: "shell",
    title: id,
    status,
    toolCallId: `call-${id}`,
    stoppable: true,
    startedAt: 1,
    ...(endedAt === undefined ? {} : { endedAt }),
  });

const active: RunFacts = { state: "active", trigger: "user", startedAt: 1 };
const done: RunFacts = { state: "completed", trigger: "user", startedAt: 1, endedAt: 99 };

function source(
  items: readonly Item[],
  run: RunFacts,
  tasks: readonly BackgroundTask[],
): BlockSource {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  const settled = run.state !== "active" && tasks.every((entry) => entry.status !== "running");
  return {
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(tasks.map((entry) => [entry.toolCallId ?? "", entry.id])),
    task: (id) => tasks.find((entry) => entry.id === id),
    turnOf: (id) => byId.get(id)?.runId,
    run: (id) => (id === "run" ? run : undefined),
    turnSettled: () => settled,
    turnStartedAt: () => run.startedAt,
    turnEndedAt: () => run.endedAt,
    unsettledTail: !settled,
  };
}

/** Where each item shows, by the index of the top-level block that holds it. */
const rowOf = (blocks: readonly Block[]) => {
  const at = new Map<string, number>();
  for (const [index, block] of blocks.entries())
    for (const id of block.kind === "background" ? block.itemIds : blockItems(block))
      at.set(id, index);
  return at;
};

const turn = [
  message("ask", "user"),
  shell("build"),
  shell("call-server"),
  thought("next"),
  message("checking-the-server", "assistant"),
  shell("curl"),
];

test("work after a background task reads below its row, in the order it happened", () => {
  const blocks = buildBlocks(source(turn, active, [task("server", "running")]));
  const at = rowOf(blocks);
  const row = at.get("call-server") ?? -1;
  expect(blocks[row]?.kind).toBe("background");
  expect(at.get("build")).toBeLessThan(row);
  for (const later of ["next", "checking-the-server", "curl"])
    expect(at.get(later)).toBeGreaterThan(row);
  // The turn's newest step is its last row: the background row never sits beneath the stream.
  expect(blocks.at(-1)).toMatchObject({ kind: "work" });
  expect(blockItems(blocks.at(-1) as Block)).toContain("curl");
});

test("rows on screen keep their place as work streams in after a background task", () => {
  let previous: string[] = [];
  for (let count = 1; count <= turn.length; count++) {
    const blocks = buildBlocks(
      source(turn.slice(0, count), active, [task("server", "running")]),
    ).filter((block) => block.kind !== "live");
    const keys = blocks.map((block) => block.key);
    // What was on screen is an unchanged prefix, and the newest item shows in the last row.
    expect(keys.slice(0, previous.length)).toEqual(previous);
    const newest = turn[count - 1]?.id ?? "";
    expect({ newest, row: rowOf(blocks).get(newest) }).toEqual({ newest, row: blocks.length - 1 });
    previous = keys;
  }
});

test("a background task that ends later keeps its row where it started", () => {
  const running = buildBlocks(source(turn, active, [task("server", "running")]));
  const ended = buildBlocks(source(turn, active, [task("server", "completed", 50)]));
  expect(ended.map((block) => block.key)).toEqual(running.map((block) => block.key));
});

test("a settled turn folds its background task between the steps around it", () => {
  const blocks = buildBlocks(
    source([...turn, message("answer", "assistant")], done, [task("server", "completed", 150)]),
  );
  expect(blocks.map((block) => block.kind)).toEqual(["user", "work", "message"]);
  const head = blocks[1];
  if (head?.kind !== "work") throw new Error("no head");
  // "Worked for" runs until the background task ended, past the run's end.
  expect(head.until).toBe(150);
  expect(head.folded?.map((block) => block.kind)).toEqual(["work", "background", "work"]);
  expect(head.folded?.flatMap((block) => block.itemIds)).toEqual([
    "build",
    "call-server",
    "next",
    "checking-the-server",
    "curl",
  ]);
});

test("background tasks started back to back still share one row", () => {
  const items = [
    message("ask", "user"),
    shell("build"),
    shell("call-server"),
    shell("call-watcher"),
    shell("curl"),
  ];
  const blocks = buildBlocks(
    source(items, active, [task("server", "running"), task("watcher", "running")]),
  );
  const rows = blocks.filter((block) => block.kind === "background");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ taskIds: ["server", "watcher"] });
  expect(rowOf(blocks).get("curl")).toBeGreaterThan(blocks.indexOf(rows[0] as Block));
});
