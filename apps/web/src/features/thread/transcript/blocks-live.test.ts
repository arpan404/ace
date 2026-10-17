import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { buildBlocks, type Block, type BlockSource, type RunFacts } from "./blocks.ts";

/*
 * A working turn's rows are append-stable: what is already on screen keeps its row (its key and
 * its kind) as the turn goes on, history pages in above it or the run starts. Only settling may
 * regroup a turn.
 */

let clock = 0;
const message = (id: string, role: "user" | "assistant", runId?: string) =>
  Item.parse({
    id,
    agentId: "root",
    createdAt: ++clock,
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text: id }],
    ...(runId ? { runId } : {}),
  });
const thought = (id: string, runId: string) =>
  Item.parse({
    id,
    agentId: "root",
    runId,
    createdAt: ++clock,
    complete: true,
    type: "reasoning",
    text: `Thinking about ${id}`,
  });
const shell = (id: string, runId: string) =>
  Item.parse({
    id,
    agentId: "root",
    runId,
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

function source(
  items: readonly Item[],
  runs: Record<string, RunFacts>,
  settled: (runId: string) => boolean,
): BlockSource {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  return {
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(),
    turnOf: (id) => byId.get(id)?.runId,
    run: (id) => runs[id],
    turnSettled: settled,
    turnStartedAt: (id) => runs[id]?.startedAt,
    turnEndedAt: (id) => runs[id]?.endedAt,
    unsettledTail: true,
  };
}

const active: RunFacts = { state: "active", trigger: "user", startedAt: 1 };
const done: RunFacts = { state: "completed", trigger: "user", startedAt: 1, endedAt: 99 };
const workKey = (blocks: readonly Block[]) => blocks.find((block) => block.kind === "work")?.key;
const onlyOld = (id: string) => id === "old";
const keyOf = (blocks: readonly Block[], kind: Block["kind"]) =>
  blocks.find((block) => block.kind === kind)?.key;
const kinds = (blocks: readonly Block[]) => new Map(blocks.map((block) => [block.key, block.kind]));

test("a working turn's rows keep their key and kind as each next item arrives", () => {
  const turn = [
    message("ask", "user", "run"),
    message("let-me-check", "assistant", "run"),
    shell("grep", "run"),
    thought("why", "run"),
    shell("test", "run"),
    message("found-it", "assistant", "run"),
    shell("fix", "run"),
  ];
  let seen = new Map<string, Block["kind"]>();
  for (let count = 1; count <= turn.length; count++) {
    const blocks = buildBlocks(source(turn.slice(0, count), { run: active }, () => false));
    const now = kinds(blocks);
    for (const [key, kind] of seen) expect({ key, kind: now.get(key) }).toEqual({ key, kind });
    seen = now;
  }
  // Everything the agent said while it worked stayed inside its one log.
  const log = buildBlocks(source(turn, { run: active }, () => false)).find(
    (block) => block.kind === "work",
  );
  expect(log?.itemIds).toEqual(["let-me-check", "grep", "why", "test", "found-it", "fix"]);
});

test("once the turn settles, what it said after its last step is the answer below its log", () => {
  const turn = [
    message("ask", "user", "run"),
    message("let-me-check", "assistant", "run"),
    shell("grep", "run"),
    message("answer", "assistant", "run"),
  ];
  const working = buildBlocks(source(turn, { run: active }, () => false));
  const settled = buildBlocks(source(turn, { run: done }, () => true));
  expect(settled.map((block) => block.kind)).toEqual(["user", "work", "message"]);
  expect(settled.at(-1)).toMatchObject({ itemId: "answer", headed: true });
  // The log keeps its row through settling: its key is the turn's, not its content's.
  expect(workKey(settled)).toBe(workKey(working));
});

test("a working log keeps its key when older history pages in above it or its first step trims", () => {
  const older = [message("old-ask", "user", "old"), message("old-answer", "assistant", "old")];
  const turn = [message("ask", "user", "run"), shell("first", "run"), shell("second", "run")];
  const runs = { old: done, run: active };
  const logKey = (items: readonly Item[]) =>
    buildBlocks(source(items, runs, onlyOld)).find(
      (block) => block.kind === "work" && block.itemIds.includes("second"),
    )?.key;
  const tail = logKey(turn);
  expect(tail).toBeDefined();
  expect(logKey([...older, ...turn])).toBe(tail);
  expect(logKey(turn.filter((item) => item.id !== "first"))).toBe(tail);
});

test("the live header and log of an admitted ask keep their keys once its run starts", () => {
  const ask = message("ask", "user");
  const before = buildBlocks(source([ask], {}, () => false));
  const live = before.find((block) => block.kind === "live");
  expect(live).toBeDefined();
  // The run starts: the ask now belongs to it, and its first output arrives.
  const asked = Item.parse({ ...ask, runId: "run" });
  const after = buildBlocks(source([asked, shell("grep", "run")], { run: active }, () => false));
  expect(after.find((block) => block.kind === "live")?.key).toBe(live?.key);
  const started = buildBlocks(source([ask, shell("early", "run")], { run: active }, () => false));
  expect(started.find((block) => block.kind === "live")?.key).toBe(live?.key);
});

test("a live turn whose ask is trimmed out of the tail keeps its rows' keys, through its ending", () => {
  const turnKeys = new Map<string, string>();
  const ask = message("ask", "user", "run");
  const steps = [shell("grep", "run"), shell("test", "run")];
  const build = (items: readonly Item[], run: RunFacts, settled: boolean) =>
    buildBlocks({ ...source(items, { run }, () => settled), turnKeys });
  const before = build([ask, ...steps], active, false);
  // The tail trimmed the ask: only the turn's own output is still loaded.
  const trimmed = build(steps, active, false);
  expect(keyOf(trimmed, "work")).toBe(keyOf(before, "work"));
  expect(keyOf(trimmed, "live")).toBe(keyOf(before, "live"));
  // The turn then fails: its ending carries the same turn key its rows had all along.
  const failed: RunFacts = { ...done, state: "failed" };
  const ended = build(steps, failed, true);
  expect(keyOf(ended, "work")).toBe(keyOf(before, "work"));
  expect(keyOf(ended, "end")).toBe(
    keyOf(buildBlocks(source([ask, ...steps], { run: failed }, () => true)), "end"),
  );
});

test("two turns answering one ask (a restart) keep distinct row keys", () => {
  const items = [message("ask", "user", "first"), shell("one", "first"), shell("two", "second")];
  const blocks = buildBlocks(
    source(
      items,
      { first: { ...done, state: "interrupted" }, second: { ...active, trigger: "restart" } },
      (id) => id === "first",
    ),
  );
  const keys = blocks.map((block) => block.key);
  expect(new Set(keys).size).toBe(keys.length);
});
