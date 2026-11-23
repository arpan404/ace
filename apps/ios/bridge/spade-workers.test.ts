import { facts, type FakeDaemon, type FakeSpadeApi } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";
import type { SpadeWorkersRow } from "./spade-worker-rows.ts";

/*
 * The workers a bot started (ADR 0161), in its chat on the iPhone: one row per worker with how it
 * stands as ace lists its thread now, so one waiting on the person says what for and leads to its
 * request, over the real SDK, a fake daemon and a fake Spade.
 */

const planner = ThreadId.parse("worker-planner");
const builder = ThreadId.parse("worker-builder");

const planReview = (interaction: string) => ({
  type: "interaction.opened" as const,
  agent: "root",
  interaction,
  blocking: true,
  request: { kind: "plan_review" as const, title: "Index the notes", markdown: "1. Read them" },
});

function threads(daemon: FakeDaemon) {
  for (const [id, title] of [
    [planner, "Index the notes"],
    [builder, "Draft the summary"],
  ] as const) {
    daemon.createThread({ id, workspaceId: "ace", title, provider: "claude", access: "ask" });
    daemon.apply(id, [facts.rootAgent("claude"), facts.turn("root")]);
  }
}

function started(api: FakeSpadeApi, conversation: string) {
  api.store(conversation, { type: "user_message", text: "Research the notes" });
  api.store(conversation, { type: "reply_started", reply: "r1" });
  for (const [worker, name] of [
    [planner, "Planner"],
    [builder, "Builder"],
  ])
    api.store(conversation, {
      type: "worker_started",
      reply: "r1",
      worker,
      kind: "ace",
      name,
      call: "call-1",
    });
}

async function research(seed: (daemon: FakeDaemon) => void = () => {}) {
  let conversation = "";
  const host = await setUp((api, daemon) => {
    threads(daemon);
    seed(daemon);
    conversation = api.addAgent({ name: "Research" }).conversation;
    started(api, conversation);
  });
  host.spade.handle({ type: "spade.open", conversationId: conversation });
  const workers = () =>
    host.patches.bubbles.find((row): row is SpadeWorkersRow => row.kind === "workers");
  return { ...host, workers };
}

test("a bot's workers show one row each, and one waiting on its plan says so and names its thread", async () => {
  const { workers } = await research((daemon) => daemon.apply(planner, [planReview("plan-1")]));

  const row = await until(() =>
    workers()?.workers[0]?.tone === "needs-you" ? workers() : undefined,
  );

  expect(row).toEqual({
    kind: "workers",
    title: "2 subagents running",
    workers: [
      {
        id: planner,
        name: "Planner",
        kind: "ace",
        thread: planner,
        conversation: null,
        tone: "needs-you",
        line: "Wants you to approve its plan",
        asking: [planner],
      },
      {
        id: builder,
        name: "Builder",
        kind: "ace",
        thread: builder,
        conversation: null,
        tone: "working",
        line: "Running",
        asking: [],
      },
    ],
  });
});

test("a worker that starts waiting on the person shows it in the open chat, without opening it again", async () => {
  const { daemon, workers } = await research();
  await until(() => workers()?.workers.every((worker) => worker.tone === "working"));

  daemon.apply(builder, [planReview("plan-2")]);

  await until(() => workers()?.workers[1]?.tone === "needs-you");
  expect(workers()?.workers[0]?.tone).toBe("working");
});

test("a worker whose delegated child waits on the person names the child, where its request is", async () => {
  const child = ThreadId.parse("worker-planner-child");
  const { workers } = await research((daemon) => {
    daemon.createThread({
      id: child,
      workspaceId: "ace",
      title: "Check the index",
      provider: "claude",
      access: "ask",
      parentThreadId: planner,
    });
    daemon.apply(child, [facts.rootAgent("claude"), facts.turn("root"), planReview("plan-3")]);
    // The planner's agent that delegated it, as the daemon tells it the child's state.
    daemon.apply(planner, [
      {
        type: "agent.seen",
        agent: "checker",
        parent: "root",
        origin: "ace",
        fidelity: "full",
        native: { provider: "claude", nativeId: "checker" },
        cwd: "/Users/dev/acme",
        name: "Checker",
      },
      {
        type: "agent.external",
        agent: "checker",
        threadId: child,
        status: { state: "needs_you", interactions: 1 },
      },
    ]);
  });

  const row = await until(() =>
    workers()?.workers[0]?.tone === "needs-you" ? workers() : undefined,
  );

  // The planner holds no request itself; the card looks up the child's under it too.
  expect(row.workers[0]?.asking).toEqual([planner, child]);
  expect(row.workers[1]?.asking).toEqual([]);
});

/** `child`, delegated by `parent`'s agent `agent`, as the daemon tells the parent its state. */
function delegated(daemon: FakeDaemon, parent: string, child: string, agent: string) {
  daemon.createThread({
    id: ThreadId.parse(child),
    workspaceId: "ace",
    title: agent,
    provider: "claude",
    access: "ask",
    parentThreadId: ThreadId.parse(parent),
  });
  daemon.apply(ThreadId.parse(parent), [
    {
      type: "agent.seen",
      agent,
      parent: "root",
      origin: "ace",
      fidelity: "full",
      native: { provider: "claude", nativeId: agent },
      cwd: "/Users/dev/acme",
      name: agent,
    },
    {
      type: "agent.external",
      agent,
      threadId: ThreadId.parse(child),
      status: { state: "needs_you", interactions: 1 },
    },
  ]);
}

const archive = (daemon: FakeDaemon, threadId: string) =>
  daemon.command({
    id: CommandId.parse(`archive-${threadId}`),
    deviceId: DeviceId.parse("seed"),
    payload: { type: "thread.archive", threadId: ThreadId.parse(threadId) },
  });

test("a worker whose archived child waits on the person still names the child, read from its own thread", async () => {
  const child = "worker-planner-archived";
  const { workers } = await research((daemon) => {
    delegated(daemon, planner, child, "checker");
    daemon.apply(ThreadId.parse(child), [
      facts.rootAgent("claude"),
      facts.turn("root"),
      planReview("plan-4"),
    ]);
    archive(daemon, child);
  });

  const row = await until(() =>
    workers()?.workers[0]?.asking.includes(child) ? workers() : undefined,
  );

  expect(row.workers[0]?.asking).toEqual([planner, child]);
  expect(row.workers[0]?.tone).toBe("needs-you");
});

test("a worker whose request waits two threads down, past one the list lacks, names every thread on the way", async () => {
  const middle = "worker-planner-middle";
  const deepest = "worker-planner-deepest";
  const { workers } = await research((daemon) => {
    delegated(daemon, planner, middle, "checker");
    daemon.apply(ThreadId.parse(middle), [facts.rootAgent("claude"), facts.turn("root")]);
    delegated(daemon, middle, deepest, "reader");
    daemon.apply(ThreadId.parse(deepest), [
      facts.rootAgent("claude"),
      facts.turn("root"),
      planReview("plan-5"),
    ]);
    archive(daemon, middle);
  });

  const row = await until(() =>
    workers()?.workers[0]?.asking.includes(deepest) ? workers() : undefined,
  );

  expect(row.workers[0]?.asking).toEqual([planner, middle, deepest]);
});

test("a finished worker outside the thread list reads as done, from its own thread", async () => {
  const { workers } = await research((daemon) => {
    daemon.apply(builder, [facts.endTurn("root")]);
    // Archived, so ace's thread list no longer holds it.
    daemon.command({
      id: CommandId.parse("archive-builder"),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.archive", threadId: builder },
    });
  });

  const row = await until(() => (workers()?.workers[1]?.line === "Done" ? workers() : undefined));

  expect(row.workers[1]?.tone).toBe("rest");
  expect(row.workers[0]?.tone).toBe("working");
});

test("a worker never reads as done while its thread still works, even before ace has listed it", async () => {
  let conversation = "";
  const { spade, patches } = await setUp((api) => {
    conversation = api.addAgent({ name: "Research" }).conversation;
    started(api, conversation);
  });
  spade.handle({ type: "spade.open", conversationId: conversation });

  const row = await until(() =>
    patches.bubbles.find((each): each is SpadeWorkersRow => each.kind === "workers"),
  );

  expect(row.title).toBe("2 subagents running");
  expect(row.workers.map((worker) => worker.tone)).toEqual(["working", "working"]);
});

test("a bot waiting on one of its workers says so in the list, where its chat shows the request", async () => {
  const { patches, spade } = await setUp((api) => {
    // As the live server says it for every worker wait.
    api.addAgent({
      name: "Research",
      state: "waiting",
      waiting_for: "worker",
      status: "A worker is waiting for you",
      last_activity: 5,
    });
  });
  spade.handle({ type: "spade.watch", on: true });

  const row = await until(() => patches.state?.list.rows?.find((each) => each.name === "Research"));

  expect([row.state, row.line]).toEqual(["needs-you", "A worker is waiting for you"]);
});

/** Research with one bot worker, Scout, made through `delegate`, as the roster lists it. */
async function scouting(scout: { queued: boolean }) {
  let conversation = "";
  let made = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const host = await setUp((api) => {
    const maker = api.addAgent({ name: "Research" });
    conversation = maker.conversation;
    made = api.addAgent({
      name: "Scout",
      state: "idle",
      parent: { id: maker.id, name: "Research" },
      queued: scout.queued,
    });
    api.store(conversation, { type: "user_message", text: "Scout the venues" });
    api.store(conversation, { type: "reply_started", reply: "r1" });
    api.store(conversation, {
      type: "worker_started",
      reply: "r1",
      worker: made.id,
      kind: "bot",
      name: "Scout",
      call: "call-1",
    });
  });
  host.spade.handle({ type: "spade.open", conversationId: conversation });
  const workers = () =>
    host.patches.bubbles.find((row): row is SpadeWorkersRow => row.kind === "workers");
  if (!made) throw new Error("no scout");
  return { ...host, workers, scout: made };
}

test("a bot worker still queued for a slot reads as waiting to start, never as having run", async () => {
  const { workers } = await scouting({ queued: true });

  // The roster alone lists the queued bot as idle; its maker's tree says it waits for a slot.
  await until(() => workers()?.workers[0]?.line === "Queued");

  expect(workers()?.title).toBe("1 subagent running");
  expect(workers()?.workers[0]?.tone).toBe("working");
});

test("a bot worker reads as done once its maker's tree says it has finished", async () => {
  const { workers } = await scouting({ queued: false });

  await until(() => workers()?.workers[0]?.line === "Done");

  expect(workers()?.title).toBe("1 subagent ran");
});
