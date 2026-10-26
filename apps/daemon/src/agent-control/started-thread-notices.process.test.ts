import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentControlOperation, type McpAttribution, type ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { createConversationStarts } from "./conversations.ts";
import { setup } from "./test-support.ts";

type Harness = ReturnType<typeof setup>;
const signal = () => new AbortController().signal;

function port(h: Harness) {
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "started"), h.clock.now);
  const context = { store: h.store, services: { workspaceActions: runtime }, signal: signal() };
  return createAgentControlPort(h.store, h.service, {
    startConversation: createConversationStarts(context, h.service, h.service.conversations),
  });
}

/** A thread the parent opened with thread_start, its first turn still running. */
async function startedThread() {
  const none = undefined;
  const h = setup({}, none, false, none, false, none, none, none, none, none, true);
  const parent = await h.parent();
  const started = await port(h).execute(
    parent,
    AgentControlOperation.parse({
      op: "thread.start",
      requestId: "started",
      title: "Docs pass",
      text: "Update the docs",
      provider: "claude",
      model: "chosen-model",
      workspace: { kind: "project" },
    }),
    signal(),
  );
  const thread = started.ok
    ? h.store.listThreads().find((row) => row.id !== parent.threadId)
    : undefined;
  if (!thread) throw new Error("Thread not started");
  await h.engine.flush();
  expect(h.service.journal.get(thread.id)).toBeUndefined();
  expect(h.store.getThread(thread.id)?.status.state).toBe("working");
  return { h, parent, thread: thread.id };
}

const message = (h: Harness, from: McpAttribution, threadId: ThreadId, text: string) =>
  port(h).execute(
    from,
    AgentControlOperation.parse({
      op: "thread.message",
      threadId,
      requestId: text.replaceAll(" ", "-"),
      text,
      delivery: "steer",
    }),
    signal(),
  );

/** Every input the parent received that tells it about a message to `thread`. */
const notices = (h: Harness, parent: ThreadId, thread: ThreadId) =>
  (h.inputs.get(parent) ?? []).filter((text) =>
    text.includes(`Your message to Docs pass (${thread})`),
  );

test("the agent that started a thread hears once when its message to that thread doesn't go in", async () => {
  const { h, parent, thread } = await startedThread();
  h.failNextSend("rejected");
  expect(await message(h, parent, thread, "Also fix the changelog")).toMatchObject({
    ok: true,
    data: { arrival: "steering" },
  });
  await h.engine.flush();
  expect(notices(h, parent.threadId, thread)).toEqual([
    expect.stringContaining("couldn't join its running turn"),
  ]);

  // A different message that fails is one more notice, never a repeat of the first.
  h.failNextSend("lost");
  await message(h, parent, thread, "Bump the version");
  await h.engine.flush();
  const told = notices(h, parent.threadId, thread);
  expect(told).toHaveLength(2);
  expect(told[1]).toContain("may or may not have reached it");

  // A daemon restart doesn't tell it again, and the kept message still reaches the thread.
  h.restartOwner();
  await h.complete(thread, "first pass");
  await h.engine.flush();
  expect(notices(h, parent.threadId, thread)).toHaveLength(2);
  expect(h.inputs.get(thread)).toContain("Also fix the changelog");
});

test("a message the started thread takes as sent sends its starter no notice", async () => {
  const { h, parent, thread } = await startedThread();
  await message(h, parent, thread, "Also fix the changelog");
  await h.engine.flush();
  expect(h.inputs.get(thread)).toContain("Also fix the changelog");
  expect(notices(h, parent.threadId, thread)).toEqual([]);
});
