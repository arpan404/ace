import { Item } from "@ace/protocol";
import { momentLine } from "@ace/ui-core";
import { expect, test } from "vitest";
import { buildBlocks, type Block, type BlockSource, type RunFacts } from "./blocks.ts";

/*
 * A usage-limit resume carries its turn on: one turn on screen, the wait one quiet row inside its
 * work, never counted as work, and never a turn read as done while its resume still runs.
 */

const base = (id: string, at: number, run: string | undefined) => ({
  id,
  agentId: "root",
  createdAt: at,
  complete: true,
  ...(run ? { runId: run } : {}),
});
const ask = (id: string, at: number) =>
  Item.parse({
    ...base(id, at, undefined),
    type: "message",
    role: "user",
    parts: [{ type: "text", text: id }],
    origin: { kind: "person", commandId: `send-${id}` },
  });
const said = (id: string, at: number, run: string) =>
  Item.parse({
    ...base(id, at, run),
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text: id }],
  });
const shell = (id: string, at: number, run: string) =>
  Item.parse({
    ...base(id, at, run),
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
/** ace's Continue once the limit lifted, as the daemon sends it. */
const resumeInput = (id: string, at: number, run: string) =>
  Item.parse({
    ...base(id, at, run),
    type: "message",
    role: "user",
    synthetic: true,
    origin: { kind: "limit_resume", commandId: `resume-${id}` },
    parts: [{ type: "text", text: "Continue where you left off." }],
  });
const launch = (id: string, at: number, run: string) =>
  Item.parse({
    ...base(id, at, run),
    type: "delegation.started",
    origin: "ace",
    childThreadId: `thread-${id}`,
    provider: "codex",
    title: id,
    role: "review",
    phase: "settled",
    status: { state: "done" },
    updatedAt: at,
    generation: 0,
  });
const finished = (id: string, at: number, run: string, child: string) =>
  Item.parse({
    ...base(id, at, run),
    type: "message",
    role: "user",
    synthetic: true,
    origin: { kind: "subagent_result", commandId: `result-${id}`, threadIds: [child] },
    parts: [{ type: "text", text: `${child} stopped: its provider hit a limit.` }],
  });

const paused: RunFacts = {
  state: "completed",
  trigger: "user",
  turn: 1,
  startedAt: 1,
  endedAt: 10,
};
const resumed = (state: RunFacts["state"]): RunFacts => ({
  state,
  trigger: "limit_resume",
  turn: 1,
  startedAt: 100,
  ...(state === "active" ? {} : { endedAt: 120 }),
});

/** A thread whose turn ends as its newest run does, as the client's turn tree says. */
function thread(items: Item[], runs: Record<string, RunFacts>, extra: Partial<BlockSource> = {}) {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  const newest = Object.keys(runs).at(-1) ?? "";
  return buildBlocks({
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(),
    turnOf: (id) => byId.get(id)?.runId,
    run: (id) => runs[id],
    turnSettled: () => runs[newest]?.state !== "active",
    turnEnding: () => {
      const run = runs[newest];
      return run && { ...run, runId: newest };
    },
    ...extra,
  });
}

const heads = (blocks: readonly Block[]) =>
  blocks.filter(
    (block): block is Extract<Block, { kind: "work" }> =>
      block.kind === "work" && block.outcome !== undefined,
  );

test("a usage-limit resume carries the paused turn on: one Worked for, without the wait, which is one row inside it", () => {
  const blocks = thread(
    [
      ask("ask", 1),
      shell("before", 2, "first"),
      resumeInput("resume", 100, "resume"),
      shell("after", 110, "resume"),
      said("answer", 120, "resume"),
    ],
    { first: paused, resume: resumed("completed") },
  );
  const [head, ...more] = heads(blocks);
  expect(more).toHaveLength(0);
  expect(head?.outcome).toBe("completed");
  // 119ms from its start to its end, less the 90ms the limit held it between its runs.
  expect((head?.until ?? 0) - (head?.startedAt ?? 0) - (head?.idle ?? 0)).toBe(29);
  // Nothing about the limit outside "Worked for"; inside, one row from its last step to the resume.
  expect(blocks.some((block) => block.kind === "moment")).toBe(false);
  expect(head?.folded?.filter((block) => block.kind === "moment")).toEqual([
    expect.objectContaining({ moment: "limit", itemIds: ["resume"], at: 100, since: 2 }),
  ]);
  expect(momentLine("limit", [resumeInput("resume", 100, "resume")], 2)).toMatchObject({
    text: "Waited for the usage limit",
    from: 2,
    to: 100,
  });
});

test("a turn seen held at its limit works again once its resume runs: it never reads done while it works", () => {
  const items = [ask("ask", 1), shell("before", 2, "first"), said("so-far", 5, "first")];
  // Held: the turn reads complete as it stands, its last message its answer.
  const held = thread(
    items,
    { first: paused },
    { heldTurn: "first", pausedTurns: new Set(["first"]) },
  );
  expect(heads(held)).toHaveLength(1);
  expect(held.some((block) => block.kind === "live")).toBe(false);

  // Resumed: the same turn works again, though it was seen held.
  const working = thread(
    [...items, resumeInput("resume", 100, "resume"), shell("after", 110, "resume")],
    { first: paused, resume: resumed("active") },
    { pausedTurns: new Set(["first"]) },
  );
  expect(heads(working)).toHaveLength(0);
  expect(working.filter((block) => block.kind === "live")).toHaveLength(1);
  expect(working.filter((block) => block.kind === "moment")).toMatchObject([{ moment: "limit" }]);
});

test("the subagents a turn launched stay in view as one block once it completes, across its limit resume", () => {
  const blocks = thread(
    [
      ask("ask", 1),
      launch("first-child", 2, "first"),
      shell("check", 3, "first"),
      resumeInput("resume", 100, "resume"),
      launch("second-child", 101, "resume"),
      said("answer", 120, "resume"),
    ],
    { first: paused, resume: resumed("completed") },
  );
  const crews = blocks.filter((block) => block.kind === "subagents");
  expect(crews).toHaveLength(1);
  expect(crews[0]?.kind === "subagents" && crews[0].itemIds).toEqual([
    "first-child",
    "second-child",
  ]);
  expect(heads(blocks)[0]?.folded?.some((block) => block.kind === "subagents")).toBe(false);
});

test("delegated work landing together reads as one row with its count", () => {
  const results = [
    finished("one", 50, "first", "child-1"),
    finished("two", 50, "first", "child-2"),
  ];
  const blocks = thread([ask("ask", 1), shell("wait", 2, "first"), ...results], {
    first: { ...paused, state: "active", endedAt: undefined },
  });
  const rows = blocks.filter((block) => block.kind === "moment");
  expect(rows).toMatchObject([{ moment: "finished", itemIds: ["one", "two"] }]);
  expect(momentLine("finished", results)?.text).toBe("2 subagents finished");
  expect(momentLine("finished", results.slice(0, 1))?.text).toBe("Delegated work finished");
});
