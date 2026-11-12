import type { Fact } from "@ace/core";
import { facts } from "@ace/fake-daemon";
import { formatMessageQuotes } from "@ace/ui-core";
import { afterEach, expect, test } from "vitest";
import { connect, fixture, latest, native, open, reset, rows, until } from "./thread-harness.ts";

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

/** The person's bubble whose text is `text`, once its row arrives. */
const bubbleFor = (text: string) =>
  rows("thread.item").find((item) => item.role === "user" && item.text === text)?.bubble as
    | Record<string, unknown>
    | undefined;

test("a fenced block renders as markdown; a paste that is plainly code is its own code run", async () => {
  const fake = start("bubble");
  const fenced = "Run this:\n```sh\nbun run test\n```\nthen report back";
  const paste = "const a = 1;\nconst b = 2;\nexport { a, b };";
  fake.apply("bubble", [
    facts.message("root", "ask", "user", fenced),
    facts.message("root", "paste", "user", paste),
  ]);
  open(connect(fake), "bubble");
  expect(await until(() => bubbleFor(fenced), "the fenced bubble")).toMatchObject({
    segments: [{ kind: "text", text: fenced }],
    markdown: "Run this:  \n```sh\nbun run test\n```\nthen report back",
    readable: true,
    long: false,
  });
  expect(await until(() => bubbleFor(paste), "the pasted bubble")).toMatchObject({
    segments: [{ kind: "code", text: paste }],
    markdown: "",
  });
});

test("a reply's quoted passages sit above its words, never in them", async () => {
  const fake = start("reply");
  const block = formatMessageQuotes([
    { id: "q", text: "double as the guard", before: "It can ", after: "." },
  ]);
  fake.apply("reply", [facts.message("root", "ask", "user", `${block}\n\nYes, do that`)]);
  open(connect(fake), "reply");
  const row = await until(
    () => rows("thread.item").find((item) => item.role === "user"),
    "the bubble",
  );
  expect(row.bubble).toMatchObject({
    segments: [{ kind: "text", text: "Yes, do that" }],
    quotes: [{ text: "double as the guard" }],
    readable: true,
  });
});

test("a bubble of only quotes has no words, and still its passages", async () => {
  const fake = start("bare");
  const block = formatMessageQuotes([{ id: "q", text: "the scripts", before: "", after: "" }]);
  fake.apply("bare", [facts.message("root", "ask", "user", block ?? "")]);
  open(connect(fake), "bare");
  const row = await until(
    () => rows("thread.item").find((item) => item.role === "user"),
    "the bubble",
  );
  expect(row.bubble).toMatchObject({ readable: false, quotes: [{ text: "the scripts" }] });
});

test("a bubble with half an emoji pair reaches native repaired, as its row text does", async () => {
  const fake = start("pair");
  const words = "\udc00" + "b".repeat(10);
  fake.apply("pair", [facts.message("root", "ask", "user", words)]);
  open(connect(fake), "pair");
  const row = await until(
    () => rows("thread.item").find((item) => item.role === "user"),
    "the bubble",
  );
  const segments = (row.bubble as { segments: { text: string }[] }).segments;
  expect(segments.map((segment) => segment.text)).toEqual(["\ufffd" + "b".repeat(10)]);
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

test("a settled turn's opened log times its thought by the step after it", async () => {
  const fake = start("settled");
  fake.apply("settled", [facts.message("root", "ask", "user", "Go"), thought("t1")], 20_000);
  fake.apply(
    "settled",
    [
      facts.tool("root", "read", {
        kind: "file.read",
        title: "Read a.ts",
        detail: { kind: "file.read", path: "a.ts" },
      }),
      facts.toolDone("root", "read"),
    ],
    5_000,
  );
  fake.apply("settled", [
    facts.message("root", "answer", "assistant", "Done."),
    facts.endTurn("root"),
  ]);
  const thread = open(connect(fake), "settled");
  const work = await until(
    () => rows("thread.block").find((row) => row.kind === "work" && row.ordinal !== null),
    "a settled head",
  );
  const key = native.frames.find(
    (frame) => frame.type === "thread.block" && frame.row === work,
  )?.id;
  thread.handle({ type: "steps.open", ordinal: Number(work.ordinal), block: String(key) });
  await until(
    () => (latest("thread.steps") as { state?: string } | undefined)?.state === "ready",
    "the steps",
  );
  const steps = native.frames
    .filter((frame) => frame.type === "thread.stepsPage")
    .flatMap((page) => page.rows as { type: string; thought: string | null }[]);
  expect(steps.find((step) => step.type === "reasoning")?.thought).toBe("Thought for 15s");
});

/** A brief another thread's agent sent this one, as the daemon stamps it. */
const brief = (item: string, text: string, origin: Record<string, unknown>): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: { type: "message", role: "user", complete: true, parts: [{ type: "text", text }], origin },
});
const sentRow = () =>
  rows("thread.block").find((row) => event(row)?.kind === "sent")?.event as
    | Record<string, unknown>
    | undefined;
const sixLines = "Fix the flaky upload test.\nOne\nTwo\nThree\nFour\nFive";

test("a brief another thread sent is the person's bubble, under a line naming and linking its sender", async () => {
  const fake = start("sent");
  fake.apply("sent", [
    brief("b1", sixLines, {
      kind: "parent_agent",
      parentThreadId: "starter",
      from: { provider: "claude" },
    }),
  ]);
  open(connect(fake), "sent");
  const row = await until(sentRow, "the sent row");
  expect(row.sent).toEqual({
    provider: "claude",
    threadId: "starter",
    host: "",
    line: "Sent from another thread",
  });
  // Its words are the bubble's, folded to four lines since a brief is often long.
  expect(row.bubble).toMatchObject({
    segments: [{ kind: "text", text: sixLines }],
    readable: true,
    long: true,
    fold: 4,
    markdown: "",
  });
});

test("a sender on a paired machine is named with its machine, and its host passed for the link", async () => {
  const fake = fixture();
  fake.createThread({
    id: "remote",
    workspaceId: "ace",
    title: "remote",
    provider: "codex",
    delegatedFrom: {
      hostId: "host-linux",
      hostName: "Linux box",
      threadId: "far",
      threadTitle: "Upload fixes",
    },
  });
  fake.apply("remote", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    brief("b2", "Short brief", { kind: "parent_agent", commandId: "c-1" }),
  ]);
  open(connect(fake), "remote");
  const row = await until(sentRow, "the sent row");
  expect(row.sent).toEqual({
    provider: "",
    threadId: "far",
    host: "host-linux",
    line: "Sent by Upload fixes · Linux box",
  });
  expect(row.bubble).toMatchObject({ long: false });
});

test("a sender ace knows nothing of reads Sent from another thread, with no thread to open", async () => {
  const fake = start("unknown");
  fake.apply("unknown", [brief("b3", "Do the thing", { kind: "parent_agent", commandId: "c-2" })]);
  open(connect(fake), "unknown");
  const row = await until(sentRow, "the sent row");
  expect(row.sent).toMatchObject({ threadId: "", host: "", line: "Sent from another thread" });
});

test("markdown the person meant reaches native with every line break kept; plain text has none", async () => {
  const fake = start("marked");
  fake.apply("marked", [
    facts.message("root", "ask", "user", "## Plan\n- one\n- two"),
    facts.message("root", "plain", "user", "see you\nlater #3"),
  ]);
  open(connect(fake), "marked");
  const marked = await until(() => bubbleFor("## Plan\n- one\n- two"), "the markdown bubble");
  expect(marked).toMatchObject({
    markdown: "## Plan  \n- one  \n- two",
    // What Copy returns: the words as written, never the drawn text.
    segments: [{ kind: "text", text: "## Plan\n- one\n- two" }],
  });
  const plain = await until(() => bubbleFor("see you\nlater #3"), "the plain bubble");
  expect(plain).toMatchObject({
    markdown: "",
    segments: [{ kind: "text", text: "see you\nlater #3" }],
  });
});
