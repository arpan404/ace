import { afterEach, expect, test } from "vitest";
import { facts, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";
import { AgentId, ItemId, ThreadId, type ProviderKind } from "@ace/protocol";
import {
  commands,
  connect,
  fixture,
  latest,
  open,
  reset,
  rows,
  sent,
  until,
} from "./thread-harness.ts";

/*
 * A thread's transitions from its messages and menu, over the real SDK and the fake daemon: a
 * fork written in the thread's own composer from an answer, the last turn or an edited message,
 * Pi's retry and rewind in place, and a fork's work brought back to its parent.
 */

afterEach(reset);

const answer = (item: string, text: string, nativeId: string) => ({
  type: "item.upsert" as const,
  agent: "root",
  item,
  draft: {
    type: "message" as const,
    role: "assistant" as const,
    complete: true,
    nativeId,
    parts: [{ type: "text" as const, text }],
  },
});

/** Two finished turns: "Plan the change" → "Here is the plan.", then "Use the other approach". */
function twoTurns(provider: ProviderKind = "codex", running = false): FakeDaemon {
  const fake = fixture();
  fake.createThread({ id: "t", workspaceId: "ace", title: "Edits", provider });
  fake.apply("t", [
    facts.rootAgent(provider),
    facts.turn("root"),
    facts.message("root", "ask-1", "user", "Plan the change"),
    answer("answer-1", "Here is the plan.", "entry-1"),
    facts.endTurn("root"),
    // A turn of its own, so it can still run while the first has ended.
    { type: "turn.started", agent: "root", nativeTurnId: "second", trigger: "user" },
    facts.message("root", "ask-2", "user", "Use the other approach"),
    answer("answer-2", "Switched approaches.", "entry-2"),
    ...(running
      ? []
      : [
          {
            type: "turn.ended" as const,
            agent: "root",
            nativeTurnId: "second",
            outcome: "completed" as const,
          },
        ]),
  ]);
  return fake;
}

type Actions = { fork: boolean; edit: boolean; rewind: boolean } | null;
const item = (text: string) => rows("thread.item").find((row) => row.text === text);
const actions = (text: string) => item(text)?.actions as Actions | undefined;
const admission = (id: string) =>
  latest("admission", id) as { ok: boolean; message: string } | undefined;
const draft = () =>
  (latest("thread.fork")?.draft ?? null) as {
    key: string;
    from: string;
    prefill: string;
    model: string;
  } | null;
const tray = () =>
  (latest("thread.attachments")?.files ?? []) as {
    id: string;
    name: string;
    carried: { ref: string } | null;
  }[];
const controls = () => latest("thread.controls")?.row as { continues: boolean } | undefined;

async function opened(fake: FakeDaemon) {
  const thread = open(connect(fake), "t");
  await until(() => item("Switched approaches."), "the newest answer");
  await until(() => controls(), "the composer's controls");
  return thread;
}

test("answers offer Fork once their turn ends; a later message offers Edit, the opening one doesn't", async () => {
  const fake = twoTurns("codex", true);
  await opened(fake);
  expect(actions("Here is the plan.")).toMatchObject({ fork: true, rewind: false });
  expect(actions("Switched approaches.")).toMatchObject({ fork: false });
  expect(actions("Use the other approach")).toMatchObject({ edit: true });
  expect(actions("Plan the change")).toMatchObject({ edit: false });
  fake.apply("t", [
    { type: "turn.ended", agent: "root", nativeTurnId: "second", outcome: "completed" },
  ]);
  await until(() => actions("Switched approaches.")?.fork, "Fork once the turn ends");
});

test("a fork from an answer is written in the composer and starts with its first message", async () => {
  const thread = await opened(twoTurns());
  const answerId = String(item("Here is the plan.")?.id);
  thread.handle({ type: "fork.open", at: { kind: "answer", itemId: answerId }, requestId: "f" });
  await until(() => admission("f")?.ok, "the fork opened");
  expect(draft()).toMatchObject({ from: "“Here is the plan.”", prefill: "" });
  await until(() => controls()?.continues, "the composer starting the fork");
  thread.handle({
    type: "send",
    text: "Try it the other way.",
    opposite: false,
    continues: true,
    requestId: "go",
  });
  const continued = await until(() => latest("thread.continued"), "the fork opening");
  expect(commands("thread.fork")[0]).toMatchObject({
    threadId: "t",
    input: "Try it the other way.",
    title: "Edits (fork)",
    point: { type: "turn" },
  });
  // The thread's own model forks natively: no selection is sent.
  expect(commands("thread.fork")[0]?.selection).toBeUndefined();
  expect(commands("thread.send")).toHaveLength(0);
  expect(continued.opened).toMatch(/^t-fork-/);
  await until(() => draft() === null, "the composer back on this thread");
});

test("editing a message forks from before it, starting from its words", async () => {
  const thread = await opened(twoTurns());
  const askId = String(item("Use the other approach")?.id);
  thread.handle({ type: "fork.open", at: { kind: "edit", itemId: askId }, requestId: "e" });
  await until(() => admission("e")?.ok, "the edit opened");
  expect(draft()?.prefill).toBe("Use the other approach");
  thread.handle({
    type: "send",
    text: "Use the first approach after all",
    opposite: false,
    continues: true,
    requestId: "go",
  });
  await until(() => commands("thread.fork").length === 1, "the fork on the wire");
  const fork = commands("thread.fork")[0] as { point: { type: string; runId: string } };
  const firstTurn = rows("thread.item").find((row) => row.text === "Here is the plan.")?.runId;
  expect(fork.point).toEqual({ type: "turn", runId: firstTurn });
});

test("the opening message can't be edited, and a closed fork sends to this thread again", async () => {
  const thread = await opened(twoTurns());
  const first = String(item("Plan the change")?.id);
  thread.handle({ type: "fork.open", at: { kind: "edit", itemId: first }, requestId: "e" });
  await until(() => admission("e"), "the refusal");
  expect(admission("e")).toMatchObject({ ok: false, message: /no earlier answer/ });
  thread.handle({ type: "fork.open", at: { kind: "latest" }, requestId: "l" });
  await until(() => admission("l")?.ok, "the last turn's fork");
  thread.handle({ type: "fork.cancel" });
  await until(() => draft() === null && controls()?.continues === false, "the fork closed");
  thread.handle({ type: "send", text: "More", opposite: false, continues: false, requestId: "s" });
  await until(() => commands("thread.send").length === 1, "a normal send");
  expect(commands("thread.fork")).toHaveLength(0);
});

test("on Pi, Retry sits under the newest answer and asks its question again from before it", async () => {
  const thread = await opened(twoTurns("pi"));
  const retry = await until(
    () => (latest("thread.transitions")?.retry ?? undefined) as { answerId: string } | undefined,
    "Retry",
  );
  expect(retry.answerId).toBe(item("Switched approaches.")?.id);
  expect(actions("Here is the plan.")).toMatchObject({ rewind: true });
  thread.handle({ type: "retry", answerId: retry.answerId, requestId: "r" });
  await until(() => commands("thread.send").length === 1, "the question asked again");
  const rollback = sent
    .map((text) => JSON.parse(text) as { type?: string; operation?: unknown })
    .find((message) => message.type === "pi.control");
  expect(rollback?.operation).toEqual({ kind: "rollback", entryId: "entry-1" });
  expect(commands("thread.send")[0]).toMatchObject({
    input: [{ type: "text", text: "Use the other approach" }],
  });
});

test("other providers offer no Retry; Pi offers none while an agent still works", async () => {
  await opened(twoTurns("codex"));
  await until(() => latest("thread.transitions"), "the transitions");
  expect(latest("thread.transitions")?.retry).toBeNull();
  await reset();
  await opened(twoTurns("pi", true));
  await until(() => latest("thread.transitions"), "the transitions");
  expect(latest("thread.transitions")).toMatchObject({ retry: null, settled: false });
});

test("a fork brings its newest answer back to its parent as the summary", async () => {
  const fake = fixture();
  fake.createThread({ id: "parent", workspaceId: "ace", title: "Parent", provider: "codex" });
  fake.createThread({
    id: "t",
    workspaceId: "ace",
    title: "Fork",
    provider: "codex",
    lineage: {
      parentThreadId: ThreadId.parse("parent"),
      parentAgentId: AgentId.parse("root"),
      point: { type: "item", itemId: ItemId.parse("parent-answer") },
      mode: "native",
      lossy: false,
    },
  });
  fake.apply("t", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Try the cache"),
    facts.message("root", "found", "assistant", "The cache halves the load."),
    facts.endTurn("root"),
  ]);
  const thread = open(connect(fake), "t");
  await until(() => latest("thread.transitions")?.parent, "the parent");
  expect(latest("thread.transitions")?.parent).toEqual({ threadId: "parent", ready: true });
  thread.handle({ type: "merge.draft" });
  const merge = await until(() => latest("thread.mergeDraft"), "the summary");
  expect(merge).toMatchObject({ ready: true, summary: "The cache halves the load." });
  thread.handle({
    type: "merge",
    summary: "Cache halves load.",
    includeCode: false,
    requestId: "m",
  });
  await until(() => commands("thread.merge").length === 1, "the merge on the wire");
  expect(commands("thread.merge")[0]).toMatchObject({
    threadId: "t",
    summary: "Cache halves load.",
    citations: [{ threadId: "t" }],
  });
});

test("a model picked while forking starts the fork there and leaves this thread where it is", async () => {
  const thread = await opened(twoTurns());
  thread.handle({ type: "fork.open", at: { kind: "latest" }, requestId: "l" });
  await until(() => admission("l")?.ok, "the fork");
  thread.handle({ type: "models" });
  const sheet = await until(
    () => latest("thread.models")?.state === "ready" && latest("thread.models"),
    "the model sheet",
  );
  expect(sheet).toMatchObject({ forking: true, asks: [] });
  thread.handle({
    type: "switchModel",
    key: "claude\u0000claude-opus-5-5",
    account: "claude-personal",
    confirmed: false,
    requestId: "pick",
  });
  await until(() => admission("pick")?.ok, "the pick");
  expect(draft()?.model).not.toBe("");
  thread.handle({
    type: "send",
    text: "On Claude",
    opposite: false,
    continues: true,
    requestId: "go",
  });
  await until(() => commands("thread.fork").length === 1, "the fork on the wire");
  expect(commands("thread.fork")[0]?.selection).toMatchObject({
    provider: "claude",
    instanceId: "claude-personal",
  });
  expect(commands("thread.switch")).toHaveLength(0);
});

test("editing a message with an image forks with the same image, removable without touching the thread", async () => {
  const image = {
    sha256: fixtureImage.sha256,
    bytes: 1024,
    mimeType: "image/png",
    name: "screen.png",
    kind: "image" as const,
    thumbnailAvailable: true,
  };
  const fake = twoTurns();
  fake.apply("t", [
    { type: "turn.started", agent: "root", nativeTurnId: "third", trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: "ask-3",
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: "What is on screen?" }],
        attachments: [image],
      },
    },
    answer("answer-3", "A login form.", "entry-3"),
    { type: "turn.ended", agent: "root", nativeTurnId: "third", outcome: "completed" },
  ]);
  fake.seedServices({ attachmentImages: [{ threadId: "t", name: "screen.png" }] });
  const thread = await opened(fake);
  await until(() => item("A login form."), "the third answer");

  const askId = String(item("What is on screen?")?.id);
  thread.handle({ type: "fork.open", at: { kind: "edit", itemId: askId }, requestId: "e" });
  await until(() => admission("e")?.ok, "the edit");
  const carried = await until(() => tray()[0], "the image on the fork's message");
  expect(carried).toMatchObject({ name: "screen.png", carried: { ref: fixtureImage.sha256 } });
  thread.handle({
    type: "send",
    text: "What is on this screen now?",
    opposite: false,
    continues: true,
    requestId: "go",
  });
  await until(() => commands("thread.fork").length === 1, "the fork on the wire");
  expect(commands("thread.fork")[0]?.context).toMatchObject({
    attachments: [{ sha256: fixtureImage.sha256 }],
  });
  // Nothing was uploaded again.
  expect(sent.some((text) => text.includes('"upload.begin"'))).toBe(false);

  // A second edit's image, removed before sending, stays the thread's.
  thread.handle({ type: "fork.open", at: { kind: "edit", itemId: askId }, requestId: "e2" });
  await until(() => admission("e2")?.ok && tray().length === 1, "the image again");
  thread.handle({ type: "detach", localId: tray()[0]?.id ?? "" });
  await until(() => tray().length === 0, "the image off the message");
  thread.handle({ type: "fork.cancel" });
  expect(sent.some((text) => text.includes('"attachment.release"'))).toBe(false);
});
