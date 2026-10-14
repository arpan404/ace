import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Command, type ThreadId } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const json = (text: string) => JSON.parse(text.split("\n")[0] ?? "") as unknown;
const notesOf = async (agent: Awaited<ReturnType<EvalWorld["agent"]>>["agent"]) =>
  z
    .object({ notes: z.array(z.object({ id: z.string(), text: z.string() })) })
    .parse((await agent.call("ace_context", { topics: ["notes"] })).data).notes;
const childOf = (text: string) =>
  z.object({ data: z.object({ threadId: z.string() }) }).parse(json(text)).data
    .threadId as ThreadId;

it("a note one agent saves reaches the project, every later session's brief, and goes when retired", async () => {
  world = await evalWorld({ browser: false });
  const { agent: first } = await world.agent({});
  const added = await first.call("ace_note_add", { text: "Run tests with bun run test" });
  const { noteId } = z.object({ noteId: z.string() }).parse(added.data);
  expect(await notesOf(first)).toEqual([
    expect.objectContaining({ id: noteId, text: "Run tests with bun run test" }),
  ]);
  // The same fact twice stays one note.
  await first.call("ace_note_add", { text: "Run tests with  bun run test" });
  expect(await notesOf(first)).toHaveLength(1);

  const { agent: second } = await world.agent({});
  expect(second.instructions).toContain('"Run tests with bun run test"');
  await second.call("ace_note_retire", { noteId });
  expect(await notesOf(second)).toEqual([]);
  const { agent: third } = await world.agent({});
  expect(third.instructions).not.toContain("Run tests with bun run test");
});

it("ace_context reads recent outcomes, uncommitted files and linked PRs in one call", async () => {
  world = await evalWorld({ browser: false });
  await world.finishedThread("Fix the cart", "Cart totals now round half-up");
  const { agent, threadId } = await world.agent({});
  world.linkPr(threadId, 7);
  world.editFile("cart.ts", "export {};\n");
  const result = await agent.call("ace_context", { topics: ["recent", "changes", "prs"] });
  expect(result.failed).toBe(false);
  expect(result.data).toMatchObject({
    recent: [expect.objectContaining({ outcome: "Cart totals now round half-up" })],
    changes: expect.objectContaining({ branch: "feat/login", files: ["cart.ts"] }),
    // The forge is offline here, so CI is honestly unknown.
    prs: [expect.objectContaining({ number: 7, threadId, ci: "unknown" })],
  });
});

it("diagnostics count identical failures and name a child that waits on the person", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  for (let attempt = 0; attempt < 3; attempt++)
    await agent.call("ace_thread_rename", { threadId: "not-a-thread", title: "x" });
  const child = childOf(
    (
      await agent.call("delegate_task", {
        requestId: "asks",
        task: "Ask first",
        role: "implementer",
        provider: "claude",
      })
    ).text,
  );
  await world.askHuman(child);
  const result = await agent.call("ace_context", { topics: ["diagnostics"] });
  expect(result.data).toMatchObject({
    diagnostics: {
      failures: [{ tool: "ace_thread_rename", count: 3 }],
      // The child's question also surfaces in this parent, so it waits on the person too.
      blocking: expect.arrayContaining([`child ${child.slice(0, 8)} is waiting on human`]),
    },
  });
});

it("a top-level thread keeps its provider's own ask tool; a delegated child gets ace_ask", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  expect(agent.has("ace_ask")).toBe(false);
  const child = childOf(
    (
      await agent.call("delegate_task", {
        requestId: "c",
        task: "Do it",
        role: "implementer",
        provider: "claude",
      })
    ).text,
  );
  expect((await world.attach(child)).agent.has("ace_ask")).toBe(true);
});

it("an unanswered question returns pending, keeps the thread waiting, and the late answer arrives as the person's message", async () => {
  world = await evalWorld({ browser: false });
  const { agent: parent } = await world.agent({});
  const child = childOf(
    (
      await parent.call("delegate_task", {
        requestId: "late",
        task: "Ask late",
        role: "implementer",
        provider: "claude",
      })
    ).text,
  );
  const { agent } = await world.attach(child);
  const result = await agent.call("ace_ask", { question: "Which colour?", timeoutSeconds: 5 });
  expect(result.data).toMatchObject({ status: "pending" });
  await world.flush();
  expect(world.store.getThread(child)?.status.state).toBe("needs_you");

  // An agent can never answer it.
  const pending = world.store.atomic((db) =>
    db.prepare("SELECT interaction_id FROM ace_ask_pending WHERE thread_id=?").get(child),
  );
  const interactionId = z.object({ interaction_id: z.string() }).parse(pending).interaction_id;
  const engine = world.daemon.engine;
  if (!engine) throw new Error("Missing engine");
  const byAgent = Command.parse({
    id: "agent-answer",
    deviceId: "ace-agent",
    payload: {
      type: "interaction.resolve",
      interactionId,
      resolution: { kind: "question", answers: { answer: ["red"] } },
    },
  });
  expect(engine.handler.handle(byAgent, world.store)).toMatchObject({
    ok: false,
    error: "human_answer_required",
  });

  await world.answerAsk(child, "blue");
  await world.flush();
  const items = world.store.readItemPage(child, world.store.headSeq() + 1, 50).items;
  expect(items).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "user",
      parts: [expect.objectContaining({ text: 'My answer to "Which colour?": blue' })],
    }),
  );
  expect(world.store.getThread(child)?.status.state).not.toBe("needs_you");
});
