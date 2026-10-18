import { expect, test } from "vitest";
import { AgentControlOperation, ThreadId, type McpAttribution } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { start } from "../engine/test-support.ts";
import { setup } from "./test-support.ts";

const signal = () => new AbortController().signal;

function harness() {
  const h = setup();
  const port = createAgentControlPort(h.store, h.service);
  const run = (caller: McpAttribution, operation: Record<string, unknown>) =>
    port.execute(caller, AgentControlOperation.parse(operation), signal());
  const fork = async (caller: McpAttribution, extra: Record<string, unknown> = {}) => {
    const result = await run(caller, {
      op: "thread.fork",
      threadId: caller.threadId,
      requestId: "try-sqlite",
      text: "Try SQLite instead of Postgres",
      ...extra,
    });
    await h.engine.flush();
    return result;
  };
  return { h, run, fork };
}

const forkOf = (result: { data?: unknown }) =>
  ThreadId.parse((result.data as { threadId: string }).threadId);

test("an agent forks its own thread mid-turn and owns the fork, which takes the new direction", async () => {
  const { h, run, fork } = harness();
  const self = await h.parent("auto-review");
  await h.emit(self.threadId, start);
  expect(h.store.getThread(self.threadId)?.status.state).toBe("working");

  const result = await fork(self, { title: "SQLite attempt" });
  expect(result).toMatchObject({
    ok: true,
    data: { title: "SQLite attempt", summary: expect.stringMatching(/^Forked/) },
  });
  const id = forkOf(result);
  expect(h.store.getThread(id)?.lineage?.parentThreadId).toBe(self.threadId);
  expect(h.inputs.get(id)?.join("\n")).toContain("Try SQLite instead of Postgres");
  expect(await fork(self, { title: "SQLite attempt" })).toEqual(result);

  await h.complete(id, "SQLite works");
  expect(
    await run(self, {
      op: "thread.message",
      threadId: id,
      requestId: "follow",
      text: "Now benchmark it",
    }),
  ).toMatchObject({ ok: true });
});

test("a finished fork merges back into its source, citing the fork's latest answer", async () => {
  const { h, run, fork } = harness();
  const self = await h.parent("auto-review");
  const id = forkOf(await fork(self));
  await h.emit(id, start);
  expect(
    await run(self, { op: "thread.merge", threadId: id, requestId: "early", summary: "Too soon" }),
  ).toMatchObject({ ok: false, code: "not_ready", hint: expect.stringContaining("wait") });

  await h.complete(id, "SQLite is twice as fast here");
  const answer = Object.values(h.store.snapshotThread(id).items).find(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expect(
    await run(self, {
      op: "thread.merge",
      threadId: id,
      requestId: "merge",
      summary: "SQLite is faster for this workload; switch to it.",
    }),
  ).toMatchObject({ ok: true, data: { mergedInto: self.threadId } });
  await h.engine.flush();
  const merged = Object.values(h.store.snapshotThread(self.threadId).items).find(
    (item) => item.type === "message" && item.mergedContext !== undefined,
  );
  expect(merged).toMatchObject({
    mergedContext: {
      sourceThreadId: id,
      summary: "SQLite is faster for this workload; switch to it.",
      citations: [{ threadId: id, itemId: answer?.id }],
    },
  });
});

test("only a fork merges back, and an agent cannot fork a thread it may not change", async () => {
  const { h, run, fork } = harness();
  const self = await h.parent("auto-review");
  const person = await h.parent("ask");
  expect(
    await run(self, {
      op: "thread.merge",
      threadId: self.threadId,
      requestId: "not-a-fork",
      summary: "Nothing",
    }),
  ).toMatchObject({ ok: false, code: "invalid", hint: expect.stringContaining("not a fork") });
  expect(await fork(self, { threadId: person.threadId })).toMatchObject({
    ok: false,
    code: "forbidden",
  });
});

test("a fork can run on another model and effort of the same provider", async () => {
  const { h, fork } = harness();
  const self = await h.parent("auto-review");
  const id = forkOf(await fork(self, { model: "chosen-model", effort: "high" }));
  expect(h.contexts.get(id)).toMatchObject({ model: "chosen-model", options: { effort: "high" } });
});
