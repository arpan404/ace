import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { buildBlocks, type Block, type RunFacts } from "./blocks.ts";

/*
 * A parent that delegates in rounds: each child's report wakes it for a short run of its own in
 * the same turn. While a child still works the turn's tree has not settled, but once the parent
 * itself has stopped its turn reads like a finished one: one "Worked for" head, with what it told
 * the person at the end of each run, and its subagent rows, in view.
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
function launch(id: string, at: number, run: string, working: boolean) {
  return Item.parse({
    id,
    agentId: "root",
    runId: run,
    createdAt: at,
    complete: !working,
    type: "delegation.started",
    origin: "ace",
    childThreadId: `thread-${id}`,
    provider: "claude",
    title: id,
    role: id,
    phase: working ? "running" : "settled",
    status: working ? { state: "working", agents: 1 } : { state: "done" },
    updatedAt: at,
    generation: 0,
  });
}
function report(id: string, at: number, run: string, child: string) {
  return Item.parse({
    id,
    agentId: "root",
    runId: run,
    createdAt: at,
    complete: true,
    type: "delegation.settled",
    origin: "ace",
    delivery: "ace-input",
    results: [
      {
        threadId: `thread-${child}`,
        outcome: "completed",
        result: `${child} finished`,
        truncated: false,
        before: null,
      },
    ],
  });
}

const rounds = [
  message("ask", "user", 1),
  shell("look", 2, "ask-run"),
  launch("accounts", 3, "ask-run", true),
  launch("mockups", 4, "ask-run", false),
  message("started", "assistant", 5, "ask-run"),
  report("mockups-back", 10, "mockups-run", "mockups"),
  message("posting", "assistant", 11, "mockups-run"),
  shell("screenshot", 12, "mockups-run"),
  message("mocked-up", "assistant", 13, "mockups-run"),
  report("review-back", 20, "review-run", "review"),
  message("forwarding", "assistant", 21, "review-run"),
  shell("send", 22, "review-run"),
  message("sent", "assistant", 23, "review-run"),
];

const wake = (startedAt: number, endedAt?: number): RunFacts =>
  endedAt === undefined
    ? { state: "active", trigger: "subagent_result", turn: 1, startedAt }
    : { state: "completed", trigger: "subagent_result", turn: 1, startedAt, endedAt };

/** The tree never settles: the accounts child is still working. */
function build(runs: Record<string, RunFacts>) {
  const byId = new Map<string, Item>(rounds.map((item) => [item.id, item]));
  const last = Object.keys(runs).at(-1) ?? "";
  return buildBlocks({
    order: rounds.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(),
    turnOf: (id) => byId.get(id)?.runId,
    run: (id) => runs[id],
    turnSettled: () => false,
    turnEnding: () => {
      const run = runs[last];
      return run ? { ...run, runId: last } : undefined;
    },
  });
}
const shown = (blocks: Block[]) =>
  blocks.map((block) => ("itemId" in block ? block.itemId : block.kind));

const stopped = {
  "ask-run": { state: "completed", trigger: "user", turn: 1, startedAt: 1, endedAt: 6 },
  "mockups-run": wake(10, 14),
  "review-run": wake(20, 24),
} satisfies Record<string, RunFacts>;

// Mutations: leaving the turn unfolded while only a child works, folding a run's closing words
// into the log, or folding the subagent rows and reports. (The mockups report joins its launch
// row, which turns into the child's result in place.)
test("a parent that stopped while a child still works folds into one head, each run's last words in view", () => {
  const blocks = build(stopped);
  expect(shown(blocks)).toEqual([
    "ask",
    "work",
    "subagents",
    "started",
    "mocked-up",
    "review-back",
    "sent",
  ]);
  const head = blocks[1];
  expect(head?.kind === "work" && head.outcome).toBe("completed");
  // What it said on its way between steps folds with the steps.
  const folded = head?.kind === "work" ? (head.folded ?? []) : [];
  expect(folded.flatMap((block) => ("itemIds" in block ? block.itemIds : []))).toEqual(
    expect.arrayContaining(["look", "posting", "screenshot", "forwarding", "send"]),
  );
});

// Mutation: letting a woken run pull the earlier runs' closing words back into its log.
test("while a report's run works, the earlier runs' last words stay where they were", () => {
  const blocks = build({ ...stopped, "review-run": wake(20) });
  expect(blocks.some((block) => block.kind === "work" && block.folded)).toBe(false);
  const messages = blocks.flatMap((block) => (block.kind === "message" ? [block.itemId] : []));
  expect(messages).toEqual(expect.arrayContaining(["started", "mocked-up"]));
});
