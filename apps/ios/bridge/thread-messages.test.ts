import type { Fact } from "@ace/core";
import { facts } from "@ace/fake-daemon";
import { afterEach, expect, test } from "vitest";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * The phone's message rows over the real SDK and an in-process fake daemon: the same
 * `@ace/ui-core` decisions the web draws. No provider CLI runs.
 */

afterEach(reset);

const failure = (item: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: {
    type: "notice",
    level: "error",
    complete: true,
    text: "The model stopped responding.",
    raw: [],
  },
});
const thought = (item: string, complete = true): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: { type: "reasoning", complete, text: "Weighing the retry budget." },
});
const event = (row: Record<string, unknown>) =>
  row.event as { kind: string; text: string; count: number } | null;

const thoughtRow = () => rows("thread.item").find((item) => item.type === "reasoning");
const answerBlock = () => rows("thread.block").find((row) => row.kind === "message");

function start(id: string) {
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
  fake.apply(id, [facts.rootAgent("codex"), facts.turn("root")]);
  return fake;
}

test("a repeated failure folds into the first error row as ×2 when it arrives", async () => {
  const fake = start("errors");
  fake.apply("errors", [facts.message("root", "ask", "user", "Go"), failure("e1")]);
  open(connect(fake), "errors");
  const first = () => rows("thread.block").find((row) => event(row)?.kind === "error");
  expect((await until(first, "the error row")).event).toMatchObject({ count: 1 });
  fake.apply("errors", [failure("e2")]);
  await until(() => event(first() ?? {})?.count === 2, "the error counted twice");
  const errors = rows("thread.block").filter((row) => event(row)?.kind === "error");
  expect(errors).toHaveLength(1);
  expect(event(errors[0] ?? {})?.text).not.toBe("");
});

test("a thought's header reads how long it took once what follows it arrives", async () => {
  const fake = start("thought");
  fake.apply("thought", [facts.message("root", "ask", "user", "Go"), thought("t1")], 12_000);
  open(connect(fake), "thought");
  expect((await until(thoughtRow, "the thought row")).thought).toBe("Thought");
  fake.apply("thought", [facts.message("root", "answer", "assistant", "Done.")]);
  await until(() => thoughtRow()?.thought === "Thought for 12s", "the thought's time");
});

test("a thought still going reads Thinking…", async () => {
  const fake = start("thinking");
  fake.apply("thinking", [facts.message("root", "ask", "user", "Go"), thought("t1", false)]);
  open(connect(fake), "thinking");
  const row = await until(
    () => rows("thread.item").find((item) => item.type === "reasoning"),
    "the thought row",
  );
  expect(row.thought).toBe("Thinking…");
});

test("the person's bubble carries its fenced code as its own run", async () => {
  const fake = start("bubble");
  fake.apply("bubble", [
    facts.message("root", "ask", "user", "Run this:\n```sh\nbun run test\n```\nthen report back"),
  ]);
  open(connect(fake), "bubble");
  const row = await until(
    () => rows("thread.item").find((item) => item.role === "user"),
    "the bubble",
  );
  expect(row.bubble).toMatchObject({
    segments: [
      { kind: "text", text: "Run this:" },
      { kind: "code", text: "bun run test" },
      { kind: "text", text: "then report back" },
    ],
    readable: true,
    long: false,
  });
});

test("an answer streams while its turn runs and stops when the turn ends", async () => {
  const fake = start("answer");
  fake.apply("answer", [
    facts.message("root", "ask", "user", "Go"),
    facts.message("root", "reply", "assistant", "Working", false),
  ]);
  open(connect(fake), "answer");
  expect((await until(answerBlock, "the answer block")).streaming).toBe(true);
  fake.apply("answer", [facts.endTurn("root")]);
  await until(() => answerBlock()?.streaming === false, "the answer settled");
});
