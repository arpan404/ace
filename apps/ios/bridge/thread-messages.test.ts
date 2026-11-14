import type { Fact } from "@ace/core";
import { facts } from "@ace/fake-daemon";
import { DelegatedFrom, MessageOrigin } from "@ace/protocol";
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

const sentRow = () =>
  rows("thread.block")
    .map((row) => row.event as Record<string, unknown> | null)
    .find((row) => row?.kind === "sent");
const sentMessage = (item: string, text: string, origin: Record<string, unknown>): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: {
    type: "message",
    role: "user",
    complete: true,
    synthetic: true,
    parts: [{ type: "text", text }],
    origin: MessageOrigin.parse(origin),
  },
});

test("a brief another thread sent names that thread, so the phone can open it", async () => {
  const fake = fixture();
  fake.createThread({
    id: "sender",
    workspaceId: "ace",
    title: "Redesign sidebar",
    provider: "claude",
  });
  fake.createThread({
    id: "brief",
    workspaceId: "ace",
    title: "brief",
    provider: "codex",
    startedBy: "sender",
  });
  const brief = Array.from({ length: 8 }, (_, i) => `Step ${i + 1} of the upload fix.`).join("\n");
  fake.apply("brief", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    sentMessage("opening", brief, {
      kind: "parent_agent",
      parentThreadId: "sender",
      from: { provider: "claude" },
    }),
  ]);
  open(connect(fake), "brief");
  const row = await until(sentRow, "the sent row");
  expect(row).toMatchObject({
    provider: "claude",
    sent: {
      threadId: "sender",
      hostId: "",
      // Its current title is the thread list's; until Swift reads it, where it came from.
      line: "Sent from another thread",
      // A brief folds to four lines, as the web's sent bubble does.
      bubble: { readable: true, long: true, fold: 4 },
    },
  });
  const sent = row?.sent as { bubble: { segments: { text: string }[] } } | undefined;
  expect(sent?.bubble.segments.map((segment) => segment.text).join("")).toBe(brief);
});

test("a brief from an agent on a paired machine names that machine's thread and the machine", async () => {
  const fake = fixture();
  fake.createThread({
    id: "remote-child",
    workspaceId: "ace",
    title: "remote child",
    provider: "codex",
    delegatedFrom: DelegatedFrom.parse({
      hostId: "host-studio",
      hostName: "Studio",
      threadId: "far-parent",
      threadTitle: "Ship the release",
      provider: "claude",
    }),
  });
  fake.apply("remote-child", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    sentMessage("task", "Check the release notes.", { kind: "spawn", role: "notes" }),
  ]);
  open(connect(fake), "remote-child");

  expect((await until(sentRow, "the sent row"))?.sent).toMatchObject({
    threadId: "far-parent",
    hostId: "host-studio",
    line: "Sent by Ship the release · Studio",
    bubble: { long: false },
  });
});

const userBubble = () => rows("thread.item").find((item) => item.role === "user")?.bubble;

test("the person's markdown reaches the bubble as markdown, every line break kept", async () => {
  const fake = start("markdown");
  fake.apply("markdown", [
    facts.message("root", "ask", "user", "Two things:\n- keep the budget\n- add a test\nThanks"),
  ]);
  open(connect(fake), "markdown");
  expect(await until(userBubble, "the bubble")).toMatchObject({
    markdown: "Two things:  \n- keep the budget  \n- add a test  \nThanks",
    fold: 10,
  });
});

test("plain words stay runs, never markdown, though they hold a # or a *", async () => {
  const fake = start("plain");
  fake.apply("plain", [facts.message("root", "ask", "user", "Fix the #3 retry * budget")]);
  open(connect(fake), "plain");
  expect(await until(userBubble, "the bubble")).toMatchObject({ markdown: "" });
});

test("words with a mention stay runs with its chip, even around markdown", async () => {
  const fake = start("mentioned");
  fake.apply("mentioned", [
    {
      type: "item.upsert",
      agent: "root",
      item: "ask",
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [
          { type: "text", text: "Use **this** with " },
          {
            type: "mention",
            entryId: "claude:skill:review",
            name: "review",
            kind: "skill",
            arguments: "",
          },
        ],
      },
    },
  ]);
  open(connect(fake), "mentioned");
  const bubble = await until(userBubble, "the bubble");
  expect(bubble).toMatchObject({ markdown: "" });
  const kinds = (bubble as { segments: { kind: string }[] }).segments.map((run) => run.kind);
  expect(kinds).toContain("mention");
});
