import { afterEach, expect, test } from "vitest";
import { CommandId } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

for (const configure of [true, false]) {
  test.each([{ model: "next-model" }, { options: { effort: "high" } }])(
    `editing a selected input to steer waits for the whole tree with configure=${configure}: %j`,
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
        delivery: "steer",
      });
      expect(receipt.ok).toBe(true);
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
      expect(h.inputs).toHaveLength(before);
      expect(session?.closed).toBe(false);
      expect(session?.selection).toMatchObject({ model: "model-a", options: {} });
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
      h.held.delete(id);
      h.emit(id, { type: "background.ended", task: "build", status: "completed" });
      await h.engine.flush();
      expect(h.inputs).toHaveLength(before + 1);
      expect(h.inputs.at(-1)).toMatchObject({ text: "selected edited", ...selection });
      expect(h.engine.queue(id).messages).toEqual([]);
    },
  );
}

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
