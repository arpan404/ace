import { BackgroundTask, Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { blockItems, buildBlocks, type Block, type BlockSource, type RunFacts } from "./blocks.ts";

/*
 * Every row sits where it happened and later work appends below it (#1180). A command left
 * running in the background is a step of the turn's log; subagent launches, conversations the
 * agent started and notices are rows of their own. None is pinned to the bottom of the turn,
 * none has later work inserted above it, and ending later updates it in place.
 */

let clock = 0;
const base = (id: string) => ({ id, agentId: "root", runId: "run", createdAt: ++clock });
const message = (id: string, role: "user" | "assistant") =>
  Item.parse({
    ...base(id),
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text: id }],
  });
const thought = (id: string) =>
  Item.parse({ ...base(id), complete: true, type: "reasoning", text: `Thinking about ${id}` });
const call = (id: string, detail: Record<string, unknown>, kind = "shell") =>
  Item.parse({
    ...base(id),
    complete: true,
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind,
      title: id,
      detail,
      status: "succeeded",
      startedAt: clock,
      raw: [],
    },
  });
const shell = (id: string) => call(id, { kind: "shell", command: `run ${id}` });
const spawn = (id: string) =>
  call(id, { kind: "agent.spawn", childAgentId: `child-${id}` }, "agent.spawn");
const startThread = (id: string) =>
  call(id, { kind: "mcp", server: "ace", tool: "thread_start" }, "mcp");
const notice = (id: string) =>
  Item.parse({ ...base(id), complete: true, type: "notice", level: "warning", text: id });
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
  tasks: readonly BackgroundTask[] = [],
): BlockSource {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  return {
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(tasks.map((entry) => [entry.toolCallId ?? "", entry.id])),
    task: (id) => tasks.find((entry) => entry.id === id),
    turnOf: (id) => byId.get(id)?.runId,
    run: (id) => (id === "run" ? run : undefined),
    agentSettled: () => true,
    turnStartedAt: () => run.startedAt,
    turnEndedAt: () => run.endedAt,
    unsettledTail: run.state === "active",
  };
}

/** Each top-level row, as its kind and the items it shows; the live line left out. */
const rows = (blocks: readonly Block[]) =>
  blocks
    .filter((block) => block.kind !== "live")
    .map((block) => `${block.kind}:${blockItems(block).join(",")}`);

const turn = [
  message("ask", "user"),
  shell("build"),
  shell("call-server"),
  thought("next"),
  message("checking-the-server", "assistant"),
  shell("curl"),
];

test("a background command is a step of the log where it started, and later work follows it there", () => {
  const blocks = buildBlocks(source(turn, active, [task("server", "running")]));
  expect(rows(blocks)).toEqual([
    "user:ask",
    "work:build,call-server,next,checking-the-server,curl",
  ]);
});

test("while the turn works, each new item lands in the last row and rows on screen stay", () => {
  let previous: string[] = [];
  for (let count = 1; count <= turn.length; count++) {
    const blocks = buildBlocks(source(turn.slice(0, count), active, [task("server", "running")]));
    const now = rows(blocks);
    const newest = turn[count - 1]?.id ?? "";
    // Rows before the last keep what they showed; the newest item is in the last row.
    expect(now.slice(0, -1)).toEqual(previous.slice(0, now.length - 1));
    expect(now.at(-1)?.split(/[:,]/)).toContain(newest);
    previous = now;
  }
});

test("a background command that ends later leaves every row as it was", () => {
  const running = buildBlocks(source(turn, active, [task("server", "running")]));
  const ended = buildBlocks(source(turn, active, [task("server", "completed", 50)]));
  expect(ended).toEqual(running);
});

test("a turn stays working while its background command runs, and settles once it ends", () => {
  const items = [...turn, message("answer", "assistant")];
  const running = buildBlocks(source(items, done, [task("server", "running")]));
  expect(running.find((block) => block.kind === "work")).toMatchObject({ ongoing: true });
  expect(running.some((block) => block.kind === "live")).toBe(true);
  const ended = buildBlocks(source(items, done, [task("server", "completed", 150)]));
  const head = ended.find((block) => block.kind === "work");
  // "Worked for" runs until the command ended, past the run's end; the command folds in place.
  expect(head).toMatchObject({ outcome: "completed", until: 150 });
  expect(head?.kind === "work" && head.itemIds).toEqual([
    "build",
    "call-server",
    "next",
    "checking-the-server",
    "curl",
  ]);
});

test("a subagent launch is its own row where it was made; later work continues below it", () => {
  const items = [message("ask", "user"), shell("build"), spawn("review"), shell("grep")];
  expect(rows(buildBlocks(source(items, active)))).toEqual([
    "user:ask",
    "work:build",
    "subagents:review",
    "work:grep",
  ]);
});

test("a launch after other work starts its own card there, never joining one above", () => {
  const items = [
    message("ask", "user"),
    spawn("first"),
    spawn("second"),
    shell("grep"),
    spawn("third"),
  ];
  expect(rows(buildBlocks(source(items, active)))).toEqual([
    "user:ask",
    "subagents:first,second",
    "work:grep",
    "subagents:third",
  ]);
});

test("a conversation the agent started is its own row where it started, outside the log and its fold", () => {
  const items = [message("ask", "user"), shell("build"), startThread("start"), shell("grep")];
  expect(rows(buildBlocks(source(items, active)))).toEqual([
    "user:ask",
    "work:build",
    "started:start",
    "work:grep",
  ]);
  const settled = buildBlocks(source([...items, message("answer", "assistant")], done));
  expect(rows(settled)).toEqual(["user:ask", "work:build,grep", "started:start", "message:answer"]);
});

test("steps after a notice continue below it, never in the log above it", () => {
  const items = [message("ask", "user"), shell("build"), notice("slow-disk"), shell("grep")];
  expect(rows(buildBlocks(source(items, active)))).toEqual([
    "user:ask",
    "work:build",
    "item:slow-disk",
    "work:grep",
  ]);
});
