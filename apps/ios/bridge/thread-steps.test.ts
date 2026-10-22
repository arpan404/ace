import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import {
  connect,
  fixture,
  latest,
  native,
  open,
  reset,
  rows,
  sent,
  until,
} from "./thread-harness.ts";

/*
 * A finished turn's full steps read on demand, a native subagent's lane grouped like the
 * transcript, and moving a queued follow-up, over the real SDK and the fake daemon. No provider
 * CLI runs.
 */

afterEach(reset);

const reads = (count: number): Fact[] =>
  Array.from({ length: count }, (_, at) => [
    facts.tool("root", `read-${at}`, {
      kind: "file.read",
      title: `Read file-${at}.ts`,
      detail: { kind: "file.read", path: `file-${at}.ts` },
    }),
    facts.toolDone("root", `read-${at}`),
  ]).flat();

test("opening a finished turn reads all its steps from the daemon, in pages", async () => {
  const fake = fixture();
  fake.createThread({ id: "long", workspaceId: "ace", title: "Long", provider: "codex" });
  fake.apply("long", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Read everything."),
    ...reads(60),
    facts.message("root", "answer", "assistant", "Read all 60."),
    facts.endTurn("root"),
  ]);
  const thread = open(connect(fake), "long");
  const work = await until(
    () => rows("thread.block").find((row) => row.kind === "work" && row.ordinal !== null),
    "a settled head",
  );
  const ordinal = Number(work.ordinal);
  const head = rows("thread.block").find((row) => row === work);
  const key = native.frames.find(
    (frame) => frame.type === "thread.block" && frame.row === head,
  )?.id;
  thread.handle({ type: "steps.open", ordinal, block: String(key) });
  const steps = await until(() => {
    const header = latest("thread.steps") as
      | { state: string; pages: number; count: number }
      | undefined;
    return header?.state === "ready" ? header : undefined;
  }, "the steps");
  expect(steps).toMatchObject({ count: 60, pages: 3 });
  // Grouped as the web's opened log groups them: sixty reads read as one sentence row.
  const log = (latest("thread.steps") as { log: { kind: string; items: string[] }[] }).log;
  expect(log.map((row) => [row.kind, row.items.length])).toEqual([["group", 60]]);
  // Pages may land a frame after the header that counts them.
  const pages = await until(() => {
    const delivered = native.frames.filter((frame) => frame.type === "thread.stepsPage");
    return delivered.length >= 3 && delivered.toSorted((a, b) => Number(a.page) - Number(b.page));
  }, "every page");
  const texts = pages.flatMap((page) =>
    (page.rows as { text: string; id: string }[]).map((row) => row.text),
  );
  expect(texts).toHaveLength(60);
  expect(texts[0]).toBe("Read file-0.ts");
  expect(texts.at(-1)).toBe("Read file-59.ts");
  expect(texts).not.toContain("Read all 60.");
  expect(sent.some((text) => text.includes('"type":"turn.steps"'))).toBe(true);
});

test("a turn that changes while its log is open is read again from its summary's end", async () => {
  const fake = fixture();
  fake.createThread({ id: "late", workspaceId: "ace", title: "Late", provider: "codex" });
  fake.apply("late", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Build it in the background."),
    ...reads(3),
    facts.tool("root", "build", {
      kind: "file.read",
      title: "Read the build log",
      detail: { kind: "file.read", path: "build.log" },
    }),
    facts.toolDone("root", "build"),
    facts.message("root", "answer", "assistant", "The build ran."),
    facts.endTurn("root"),
  ]);
  const thread = open(connect(fake), "late");
  const work = await until(
    () => rows("thread.block").find((row) => row.kind === "work" && row.ordinal !== null),
    "a settled head",
  );
  const key = native.frames.find(
    (frame) => frame.type === "thread.block" && frame.row === work,
  )?.id;
  thread.handle({ type: "steps.open", ordinal: Number(work.ordinal), block: String(key) });
  type Step = { text: string };
  const shown = () =>
    native.frames
      .filter((frame) => frame.type === "thread.stepsPage")
      .flatMap((frame) => frame.rows as Step[])
      .map((row) => row.text);
  await until(() => shown().includes("Read the build log"), "the build step");
  const readsBefore = sent.filter((text) => text.includes('"type":"turn.steps"')).length;
  // A late result reaches the finished turn: its step changes while the log is open.
  fake.apply("late", [
    facts.tool("root", "build", {
      kind: "file.read",
      title: "Read the finished build log",
      detail: { kind: "file.read", path: "build.log" },
    }),
  ]);
  await until(() => shown().includes("Read the finished build log"), "the step read again");
  expect(sent.filter((text) => text.includes('"type":"turn.steps"')).length).toBeGreaterThan(
    readsBefore,
  );
  expect(sent.some((text) => text.includes('"type":"turns.page"'))).toBe(true);
});

test("a native subagent's lane groups its own work like the transcript", async () => {
  const fake = fixture();
  fake.createThread({ id: "lane", workspaceId: "ace", title: "Lane", provider: "codex" });
  fake.apply("lane", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Explore."),
    facts.tool("root", "spawn", {
      kind: "agent.spawn",
      title: "Explore",
      detail: { kind: "agent.spawn", description: "Explore", childAgent: "explore" },
    }),
    facts.subagent("codex", "explore", "Explore", "spawn"),
    facts.turn("explore", "spawn"),
    facts.tool("explore", "look", {
      kind: "file.read",
      title: "Read owner.ts",
      detail: { kind: "file.read", path: "owner.ts" },
    }),
    facts.toolDone("explore", "look"),
    facts.message("explore", "found", "assistant", "Groups are per thread."),
    facts.endTurn("explore"),
  ]);
  const thread = open(connect(fake), "lane");
  const group = await until(
    () => rows("thread.block").find((row) => row.kind === "subagents"),
    "the group",
  );
  const entry = (group.agents as { entries: { agentId: string }[] }).entries[0];
  thread.handle({ type: "lane.open", agentId: String(entry?.agentId) });
  const lane = await until(() => {
    const blocks = native.frames.filter((frame) => frame.type === "thread.laneBlock");
    return blocks.some((frame) => (frame.row as { kind?: string } | null)?.kind === "message")
      ? blocks
      : undefined;
  }, "the lane's blocks");
  expect(lane.every((frame) => frame.lane === entry?.agentId)).toBe(true);
  const kinds = lane.map((frame) => (frame.row as { kind: string }).kind);
  expect(kinds).toContain("work");
  expect(kinds).not.toContain("user");
});

test("a queued follow-up moves down past the next one, fenced to the queue it saw", async () => {
  const fake = fixture();
  fake.createThread({ id: "order", workspaceId: "ace", title: "Order", provider: "codex" });
  fake.apply("order", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  const thread = open(connect(fake), "order");
  await until(() => (latest("thread.controls")?.row as { busy?: boolean })?.busy, "a busy thread");
  type Queue = { messages: { id: string; text: string }[] };
  const queue = () => latest("thread.queue") as Queue | undefined;
  thread.handle({ type: "send", text: "First", opposite: false, requestId: "q1" });
  thread.handle({ type: "send", text: "Second", opposite: false, requestId: "q2" });
  await until(() => queue()?.messages.length === 2, "two queued");
  const first = queue()?.messages[0];
  thread.handle({
    type: "queue",
    messageId: String(first?.id),
    change: { kind: "move", step: -1 },
    requestId: "top",
  });
  await until(() => latest("admission", "top"), "the refusal at the top");
  expect(latest("admission", "top")?.ok).toBe(false);
  thread.handle({
    type: "queue",
    messageId: String(first?.id),
    change: { kind: "move", step: 1 },
    requestId: "down",
  });
  await until(() => queue()?.messages[0]?.text === "Second", "the new order");
  expect(queue()?.messages.map((message) => message.text)).toEqual(["Second", "First"]);
});
