import { facts, type FakeDaemon, type FakeSpadeApi } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
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
    title: "Started 2 agents",
    workers: [
      {
        id: planner,
        name: "Planner",
        kind: "ace",
        thread: planner,
        conversation: null,
        tone: "needs-you",
        line: "Waiting for you to approve its plan",
      },
      {
        id: builder,
        name: "Builder",
        kind: "ace",
        thread: builder,
        conversation: null,
        tone: "working",
        line: "Running",
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

  expect(row.title).toBe("Started 2 agents");
  expect(row.workers.map((worker) => worker.tone)).toEqual(["working", "working"]);
});

test("a bot waiting on one of its workers says so in the list, where its chat shows the request", async () => {
  const { patches, spade } = await setUp((api) => {
    api.addAgent({ name: "Research", state: "waiting", waiting_for: "worker", last_activity: 5 });
  });
  spade.handle({ type: "spade.watch", on: true });

  const row = await until(() => patches.state?.list.rows?.find((each) => each.name === "Research"));

  expect([row.state, row.line]).toEqual(["needs-you", "An agent it started needs you"]);
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

  expect(workers()?.title).toBe("Started 1 agent");
  expect(workers()?.workers[0]?.tone).toBe("working");
});

test("a bot worker reads as done once its maker's tree says it has finished", async () => {
  const { workers } = await scouting({ queued: false });

  await until(() => workers()?.workers[0]?.line === "Done");

  expect(workers()?.title).toBe("1 agent ran");
});
