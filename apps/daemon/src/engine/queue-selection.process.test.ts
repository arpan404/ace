import { afterEach, expect, test } from "vitest";
import { CommandId } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

for (const configure of [true, false]) {
  test.each([{ model: "next-model" }, { options: { effort: "high" } }])(
    `a queued message changed to steer goes into the running turn and its selection waits for the tree with configure=${configure}: %j`,
    async (selection) => {
      const h = transitionHarness({ configure });
      cleanups.push(h.close);
      const id = await h.create();
      h.held.add(id);
      expect(
        h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "active" }] })
          .ok,
      ).toBe(true);
      await h.engine.flush();
      const before = h.inputs.length;
      const session = h.sessions.at(-1);
      const receipt = h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "selected" }],
        ...selection,
        delivery: "queue",
      });
      expect(receipt.ok).toBe(true);
      await h.engine.flush();
      expect(h.inputs).toHaveLength(before);
      expect(
        h.command({
          type: "queue.edit",
          threadId: id,
          messageId: CommandId.parse(receipt.commandId),
          expectedRevision: h.engine.queue(id).revision,
          input: [{ type: "text", text: "selected edited" }],
          delivery: "steer",
        }).ok,
      ).toBe(true);
      await h.engine.flush();
      expect(h.inputs).toHaveLength(before + 1);
      expect(h.inputs.at(-1)).toMatchObject({
        text: "selected edited",
        delivery: "steer",
        model: "model-a",
        options: {},
      });
      expect(h.engine.queue(id).messages).toEqual([]);
      h.emit(
        id,
        {
          type: "background.started",
          agent: "root",
          task: "build",
          kind: "shell",
          title: "Build",
          stoppable: true,
        },
        { type: "turn.ended", agent: "root", outcome: "completed" },
      );
      await h.engine.flush();
      // Switching may reopen the session, which would end the build: the selection waits.
      expect(session?.closed).toBe(false);
      expect(session?.selection).toMatchObject({ model: "model-a", options: {} });
      h.held.delete(id);
      h.emit(id, { type: "background.ended", task: "build", status: "completed" });
      await h.engine.flush();
      expect(
        h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] })
          .ok,
      ).toBe(true);
      await h.engine.flush();
      expect(h.inputs).toHaveLength(before + 2);
      expect(h.inputs.at(-1)).toMatchObject({ text: "next", ...selection });
    },
  );
}

test("a steer carrying a different effort goes into the running turn; the effort applies to the next turn", async () => {
  const h = transitionHarness();
  cleanups.push(h.close);
  const id = await h.create();
  h.held.add(id);
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "active" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  const before = h.inputs.length;
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "think harder" }],
      options: { effort: "high" },
      delivery: "steer",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs).toHaveLength(before + 1);
  expect(h.inputs.at(-1)).toMatchObject({ text: "think harder", delivery: "steer", options: {} });
  expect(h.engine.queue(id).messages).toEqual([]);
  expect(h.store.getThread(id)?.switch).toMatchObject({
    state: "queued",
    selection: { options: { effort: "high" } },
  });
  h.held.delete(id);
  h.emit(id, { type: "turn.ended", agent: "root", outcome: "completed" });
  await h.engine.flush();
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs).toHaveLength(before + 2);
  expect(h.inputs.at(-1)).toMatchObject({ text: "next", options: { effort: "high" } });
});

test("a steer with a new model during background-only work goes in at once; the model waits for that work", async () => {
  const h = transitionHarness();
  cleanups.push(h.close);
  const id = await h.create();
  h.held.add(id);
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "active" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  h.emit(
    id,
    {
      type: "background.started",
      agent: "root",
      task: "build",
      kind: "shell",
      title: "Build",
      stoppable: true,
    },
    { type: "turn.ended", agent: "root", outcome: "completed" },
  );
  await h.engine.flush();
  const before = h.inputs.length;
  const session = h.sessions.at(-1);
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "while it builds" }],
      model: "next-model",
      delivery: "steer",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs).toHaveLength(before + 1);
  expect(h.inputs.at(-1)).toMatchObject({
    text: "while it builds",
    delivery: "steer",
    model: "model-a",
  });
  expect(session?.closed).toBe(false);
  expect(session?.selection).toMatchObject({ model: "model-a" });
  h.held.delete(id);
  h.emit(
    id,
    { type: "turn.ended", agent: "root", outcome: "completed" },
    { type: "background.ended", task: "build", status: "completed" },
  );
  await h.engine.flush();
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs.at(-1)).toMatchObject({ text: "next", model: "next-model" });
});

test("a steer with a new effort keeps the model a queued switch picked", async () => {
  const h = transitionHarness();
  cleanups.push(h.close);
  const id = await h.create();
  h.held.add(id);
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "active" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "codex", model: "next-model" },
    }).ok,
  ).toBe(true);
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "think harder" }],
      options: { effort: "high" },
      delivery: "steer",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs.at(-1)).toMatchObject({ text: "think harder", delivery: "steer" });
  h.held.delete(id);
  h.emit(id, { type: "turn.ended", agent: "root", outcome: "completed" });
  await h.engine.flush();
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs.at(-1)).toMatchObject({
    text: "next",
    model: "next-model",
    options: { effort: "high" },
  });
});

test("a provider that can't steer queues a steer with its selection until the tree settles", async () => {
  const h = transitionHarness({ steer: false });
  cleanups.push(h.close);
  const id = await h.create();
  h.held.add(id);
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "active" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  const before = h.inputs.length;
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "think harder" }],
      options: { effort: "high" },
      delivery: "steer",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs).toHaveLength(before);
  expect(h.engine.queue(id).messages).toMatchObject([{ requiresNextTurn: true }]);
  h.held.delete(id);
  h.emit(
    id,
    {
      type: "background.started",
      agent: "root",
      task: "build",
      kind: "shell",
      title: "Build",
      stoppable: true,
    },
    { type: "turn.ended", agent: "root", outcome: "completed" },
  );
  await h.engine.flush();
  expect(h.inputs).toHaveLength(before);
  h.emit(id, { type: "background.ended", task: "build", status: "completed" });
  await h.engine.flush();
  expect(h.inputs).toHaveLength(before + 1);
  expect(h.inputs.at(-1)).toMatchObject({
    text: "think harder",
    delivery: "queue",
    options: { effort: "high" },
  });
});

test.each([{ options: {} }, { model: "model-a", options: {} }])(
  "a send restating the thread's own model and options starts the next turn while background work runs: %j",
  async (restated) => {
    const h = transitionHarness();
    cleanups.push(h.close);
    const id = await h.create();
    h.held.add(id);
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "active" }] })
        .ok,
    ).toBe(true);
    await h.engine.flush();
    h.held.delete(id);
    h.emit(
      id,
      {
        type: "background.started",
        agent: "root",
        task: "build",
        kind: "shell",
        title: "Build",
        stoppable: true,
      },
      { type: "turn.ended", agent: "root", outcome: "completed" },
    );
    await h.engine.flush();
    const before = h.inputs.length;
    const session = h.sessions.at(-1);
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "while it builds" }],
        ...restated,
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.inputs).toHaveLength(before + 1);
    expect(h.inputs.at(-1)).toMatchObject({ text: "while it builds", model: "model-a" });
    expect(session?.closed).toBe(false);
    expect(h.engine.queue(id).messages).toEqual([]);
  },
);

test("a send restating the thread's options steers into the running turn", async () => {
  const h = transitionHarness();
  cleanups.push(h.close);
  const id = await h.create();
  h.held.add(id);
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "active" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  const before = h.inputs.length;
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "steered" }],
      options: {},
      delivery: "steer",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs).toHaveLength(before + 1);
  expect(h.inputs.at(-1)).toMatchObject({ text: "steered" });
  expect(h.engine.queue(id).messages).toEqual([]);
});
