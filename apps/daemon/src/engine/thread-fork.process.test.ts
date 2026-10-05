import { afterEach, expect, test } from "vitest";
import { ItemId, PortableHandoff } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function setup(options: Parameters<typeof transitionHarness>[0] = {}) {
  const h = transitionHarness(options);
  cleanup.push(h.close);
  return h;
}
test("native fork retains source history and records independent tree lineage", async () => {
  const h = setup({ native: true });
  const source = await h.create();
  const run = h.finishedRun(source);
  const fork = await h.fork(source);
  const view = h.store.snapshotThread(fork);
  expect(view.thread.lineage).toMatchObject({
    parentThreadId: source,
    point: { type: "turn", runId: run.id },
    mode: "native",
    lossy: false,
  });
  const root = Object.values(view.agents).find((agent) => agent.origin === "root");
  expect(root).toMatchObject({ parentId: null, lineage: view.thread.lineage });
  expect(
    Object.values(view.items)
      .filter((item) => item.type === "message")
      .map((item) => item.parts),
  ).toEqual(
    expect.arrayContaining([
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("source history") }),
      ]),
    ]),
  );
  expect(h.sessions.at(-1)?.context.fork?.point.nativeId).toBe(run.nativeId);
  expect(h.store.getThread(source)?.status.state).toBe("done");
});
test("providers without native forks receive cited handoff with omitted-history pointers", async () => {
  const h = setup();
  const source = await h.create();
  const fork = await h.fork(source);
  const input = h.inputs.at(-1)?.text ?? "";
  const handoff = PortableHandoff.parse(
    JSON.parse(input.slice(0, input.indexOf("\ncontinue fork"))),
  );
  expect(handoff.sourceThreadId).toBe(source);
  expect(handoff.excerpts[0]?.citation.threadId).toBe(source);
  expect(handoff.excerpts[0]?.text).toContain("source history");
  expect(handoff.history).toMatchObject({ type: "items.page", threadId: source });
  expect(h.store.getThread(fork)?.lineage).toMatchObject({ mode: "portable", lossy: true });
});
test("a failed run can fork its complete provider history", async () => {
  const h = setup({ native: true, outcome: "failed" });
  const source = await h.create();
  expect(h.finishedRun(source).state).toBe("failed");
  const fork = await h.fork(source);
  expect(h.inputs.at(-1)?.nativeId).not.toBe(h.inputs[0]?.nativeId);
  expect(h.store.getThread(fork)?.lineage?.mode).toBe("native");
});
test("an interrupted run can fork at an exact native item", async () => {
  const h = setup({ native: true, outcome: "interrupted" });
  const source = await h.create();
  const item = Object.values(h.store.snapshotThread(source).items).find(
    (candidate) => candidate.type === "message" && candidate.role === "assistant",
  );
  if (!item) throw new Error("No source item");
  const result = h.command({
    type: "thread.fork",
    threadId: source,
    point: { type: "item", itemId: item.id },
    input: "branch item",
    budgetBytes: 4096,
  });
  expect(result.ok).toBe(true);
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.fork?.point).toEqual({ type: "item", nativeId: item.nativeId });
});
test("a usage-limited finished run forks without waiting for a reset", async () => {
  const h = setup({ native: true, outcome: "failed", limited: true });
  const source = await h.create();
  expect(h.store.getThread(source)?.status).toMatchObject({ state: "limited" });
  const fork = await h.fork(source);
  expect(h.store.getThread(fork)?.lineage?.parentThreadId).toBe(source);
  expect(h.sessions.at(-1)?.context.fork).toBeDefined();
});
test("a merge becomes cited context in the source and reaches its next provider turn", async () => {
  const h = setup();
  const source = await h.create();
  const fork = await h.fork(source);
  const item = Object.values(h.store.snapshotThread(fork).items).find(
    (candidate) => candidate.type === "message" && candidate.role === "assistant",
  );
  if (!item) throw new Error("No fork item");
  expect(
    h.command({
      type: "thread.merge",
      threadId: fork,
      summary: "Use the fork's parser fix",
      citations: [{ threadId: fork, itemId: item.id }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const merged = Object.values(h.store.snapshotThread(source).items).find(
    (candidate) => candidate.type === "message" && candidate.synthetic,
  );
  expect(merged?.type === "message" && merged.mergedContext).toMatchObject({
    sourceThreadId: fork,
    summary: "Use the fork's parser fix",
    citations: [{ threadId: fork, itemId: item.id }],
    patchApplied: false,
  });
  expect(merged?.type === "message" && merged.parts).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(item.id) })]),
  );
  expect(
    h.command({
      type: "thread.send",
      threadId: source,
      input: [{ type: "text", text: "implement" }],
      delivery: "queue",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs.at(-1)?.text).toContain("Use the fork's parser fix");
  expect(h.inputs.at(-1)?.text).toContain(item.id);
});
test("merges reject citations outside the fork and leave source history unchanged", async () => {
  const h = setup();
  const source = await h.create();
  const fork = await h.fork(source);
  const before = h.store.snapshotThread(source).itemOrder;
  const result = h.command({
    type: "thread.merge",
    threadId: fork,
    summary: "invalid",
    citations: [{ threadId: fork, itemId: ItemId.parse("missing") }],
  });
  expect(result.ok).toBe(false);
  expect(h.store.snapshotThread(source).itemOrder).toEqual(before);
});
test("a finished run can fork while its source background task remains live", async () => {
  const h = setup({ native: true });
  const source = await h.create();
  h.emit(source, {
    type: "background.started",
    agent: "root",
    task: "live",
    kind: "shell",
    title: "build",
    stoppable: true,
  });
  await h.engine.flush();
  expect(
    h.command({
      type: "thread.fork",
      threadId: source,
      point: { type: "turn", runId: h.finishedRun(source).id },
      input: "branch",
      budgetBytes: 4096,
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(source)?.status).toMatchObject({
    state: "waiting",
    on: "background_task",
  });
  expect(h.store.listThreads()).toHaveLength(2);
});

test("a provider supporting whole-session forks uses native history at the latest finished run", async () => {
  const h = setup({ native: true, forkPoints: ["end"] });
  const source = await h.create();
  const fork = await h.fork(source);
  expect(h.store.getThread(fork)?.lineage).toMatchObject({ mode: "native", lossy: false });
  expect(h.sessions.at(-1)?.context.fork?.point.type).toBe("end");
  expect(h.inputs.at(-1)?.text).toBe("continue fork");
});

test("older turns fall back portably when only whole-session forks are supported", async () => {
  const h = setup({ native: true, forkPoints: ["end"] });
  const source = await h.create();
  const first = h.finishedRun(source);
  h.command({
    type: "thread.send",
    threadId: source,
    input: [{ type: "text", text: "later secret" }],
    delivery: "queue",
  });
  await h.engine.flush();
  const fork = await h.fork(source, { type: "turn", runId: first.id });
  expect(h.store.getThread(fork)?.lineage?.mode).toBe("portable");
  expect(h.inputs.at(-1)?.text).toContain("source history");
  expect(h.inputs.at(-1)?.text).not.toContain("later secret");
});
