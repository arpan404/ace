import { expect, test } from "vitest";
import type { McpAttribution, ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { setup } from "./test-support.ts";
import { task } from "../engine/test-support.ts";

type Harness = ReturnType<typeof setup>;

/** A delegated child whose first turn is still running. */
async function runningChild(steer: boolean) {
  const none = undefined;
  const h = setup({}, none, false, none, false, none, none, none, none, none, steer);
  const parent = await h.parent();
  const child = h.delegate(parent, "worker");
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.status.state).toBe("working");
  return { h, parent, child: child.childId };
}

const message = (
  h: Harness,
  parent: McpAttribution,
  threadId: ThreadId,
  text: string,
  delivery?: "queue" | "steer",
) =>
  createAgentControlPort(h.store, h.service).execute(
    parent,
    {
      op: "thread.message",
      threadId,
      requestId: `message-${text.length}`,
      text,
      ...(delivery ? { delivery } : {}),
    },
    new AbortController().signal,
  );

const received = (h: Harness, id: ThreadId) => h.inputs.get(id) ?? [];

test("a parent's message reaches its running child's turn now when the provider steers", async () => {
  const { h, parent, child } = await runningChild(true);
  const sent = await message(h, parent, child, "New repo rule");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "steering" } });
  await h.engine.flush();
  expect(received(h, child)).toContain("New repo rule");
  expect(h.inputMessages.get(child)?.at(-1)).toMatchObject({ delivery: "steer" });
  // The child's turn goes on with the message in it: nothing reads it as done.
  expect(h.store.getThread(child)?.status.state).toBe("working");
});

test("a parent's message to a child that can't steer says it waits, then runs when the turn ends", async () => {
  const { h, parent, child } = await runningChild(false);
  const sent = await message(h, parent, child, "New repo rule");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "queued" } });
  await h.engine.flush();
  expect(received(h, child)).not.toContain("New repo rule");
  expect(h.service.monitor.snapshot(parent).children).toMatchObject([
    { id: child, state: "working", queued: 1 },
  ]);
  await h.complete(child, "first pass");
  expect(received(h, child)).toContain("New repo rule");
  // The child is on the parent's message now; its first answer is not its result.
  expect(h.store.getThread(child)?.status.state).toBe("working");
  expect(h.service.journal.get(child)?.phase).not.toBe("settled");
});

test("a parent's message starts the child's next turn while its background command keeps running", async () => {
  const { h, parent, child } = await runningChild(true);
  await h.emit(child, task);
  await h.complete(child, "Started the dev server");
  expect(h.store.getThread(child)?.status).toEqual({ state: "waiting", on: "background_task" });
  const sent = await message(h, parent, child, "Now run the tests", "queue");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "starting" } });
  await h.engine.flush();
  expect(received(h, child)).toContain("Now run the tests");
  expect(h.stoppedTasks).toEqual([]);
});

test("a settled child its parent messages again reads working, never its old result", async () => {
  const { h, parent, child } = await runningChild(true);
  await h.complete(child, "first pass");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.service.journal.get(child)?.phase).toBe("settled");
  const sent = await message(h, parent, child, "Also update the docs");
  expect(sent).toMatchObject({ ok: true, data: { arrival: "starting" } });
  // Before the provider has taken the message, nothing reports the child finished.
  expect(h.service.monitor.snapshot(parent).children).toMatchObject([
    { id: child, state: "working" },
  ]);
  const waiting = h.service.monitor.wait(
    parent,
    { threadIds: [child], mode: "all", timeoutSeconds: 1 },
    new AbortController().signal,
  );
  h.clock.advance(h.clock.now() + 1000);
  expect(await waiting).toMatchObject({ ok: true, data: { status: "timeout" } });
});
