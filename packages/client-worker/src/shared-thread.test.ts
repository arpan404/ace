import { type ThreadReader, type ThreadSource } from "@ace/client";
import { ScenarioPlayer, flakyCheckout, workbench } from "@ace/fake-daemon";
import { InteractionId } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { cleanups, world } from "./worker-test-support.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const pending = (reader: ThreadReader) =>
  reader.interactionIds().flatMap((id) => {
    const interaction = reader.interaction(id);
    return interaction?.state === "pending" ? [interaction] : [];
  });

function watch(store: ThreadSource) {
  const selection = store.select(["interactions"], pending);
  let visible = selection.getSnapshot();
  const stop = selection.subscribe(() => {
    visible = selection.getSnapshot();
  });
  cleanups.push(stop);
  return { read: () => visible, stop };
}

test("a thread's question stays visible to overlapping subscribers and after either leaves", async () => {
  const { daemon, tab } = world();
  const scenario = workbench().find((candidate) => candidate.thread.id === "thread-sheet-rotate");
  if (!scenario) throw new Error("Missing ordinary question scenario");
  const script = new ScenarioPlayer(daemon, scenario);
  script.runUntilBlocked();
  const client = tab();
  await client.start();
  const first = client.thread(script.threadId);
  const left = watch(first.store);
  const second = client.thread(script.threadId);
  const right = watch(second.store);
  await vi.waitFor(() => {
    expect(left.read()).toMatchObject([{ state: "pending", request: { kind: "question" } }]);
    expect(right.read()).toEqual(left.read());
  });
  const interactionId = left.read()[0]?.id;
  if (!interactionId) throw new Error("Missing question");
  await client.request({ type: "diagnostics.health" });
  expect(left.read()).toEqual(right.read());
  expect(right.read()).toMatchObject([{ id: interactionId, request: { kind: "question" } }]);
  left.stop();
  first.release();
  first.release();
  // The survivor still receives live updates; nothing reacquires the thread first.
  expect(
    await client.command({
      type: "interaction.resolve",
      interactionId: InteractionId.parse(interactionId),
      resolution: { kind: "question", answers: { recovery: ["persist"] } },
    }),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(right.read()).toEqual([]));
  expect(second.store.interaction(interactionId)?.state).toBe("resolved");
  right.stop();
  second.release();
});

test("a normal thread's approval survives overlapping leases, release and resubscription", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  script.runUntilBlocked();
  const client = tab();
  await client.start();
  const first = client.thread(script.threadId);
  const left = watch(first.store);
  await vi.waitFor(() =>
    expect(left.read()).toMatchObject([{ state: "pending", request: { kind: "approval" } }]),
  );
  const expected = left.read();
  const second = client.thread(script.threadId);
  const right = watch(second.store);
  await client.request({ type: "diagnostics.health" });
  expect(left.read()).toEqual(expected);
  expect(right.read()).toEqual(expected);
  right.stop();
  second.release();
  second.release();
  const approval = expected[0];
  if (approval?.request.kind !== "approval") throw new Error("Missing approval");
  const option = approval.request.options.find((entry) => entry.kind === "allow_once");
  if (!option) throw new Error("Missing approval option");
  // The survivor still receives live updates; nothing reacquires the thread first.
  expect(
    await client.command({
      type: "interaction.resolve",
      interactionId: approval.id,
      resolution: { kind: "approval", optionId: option.id },
    }),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(left.read()).toEqual([]));
  left.stop();
  first.release();
  await client.request({ type: "diagnostics.health" });
  const resumed = client.thread(script.threadId);
  await vi.waitFor(() => expect(resumed.store.interaction(approval.id)?.state).toBe("resolved"));
  resumed.release();
});

async function fiveHydratedThreadsGoOffline(world_: ReturnType<typeof world>) {
  const { daemon, tab } = world_;
  const client = tab();
  await client.start();
  const ids = Array.from({ length: 5 }, (_, index) => `paced-${index}`);
  for (const id of ids)
    daemon.createThread({ id, workspaceId: "project", title: "Before", provider: "codex" });
  const held = ids.map((id) => client.thread(id));
  cleanups.push(() => held.forEach((lease) => lease.release()));
  await vi.waitFor(() => {
    for (const lease of held) expect(lease.store.thread?.title).toBe("Before");
  });
  client.networkOnline(false);
  await vi.waitFor(() => expect(client.state).toBe("offline"));
  for (const id of ids) daemon.updateThread(id, { title: "After" });
  return { client, held };
}

test("every hydrated thread catches up after a reconnect replay", async () => {
  const { client, held } = await fiveHydratedThreadsGoOffline(world());
  client.networkOnline(true);
  await vi.waitFor(() => {
    for (const lease of held) expect(lease.store.thread?.title).toBe("After");
  });
});

test("a complete snapshot admits queued threads while reconnect replay still waits for completion", async () => {
  const setup = world();
  const { client, held } = await fiveHydratedThreadsGoOffline(setup);
  const withheld: (() => void)[] = [];
  setup.faults.incoming = (message, text, deliver) => {
    // Replay data arrives; the daemon's completion acknowledgements are held back.
    if (message.type === "subscription.ready") withheld.push(() => deliver(text));
    else deliver(text);
  };
  client.networkOnline(true);
  await vi.waitFor(() => expect(held[3]?.store.thread?.title).toBe("After"));
  await client.request({ type: "diagnostics.health" });
  expect(held[4]?.store.thread?.title).toBe("Before");
  expect(withheld).toHaveLength(4);
  withheld.shift()?.();
  await vi.waitFor(() => expect(held[4]?.store.thread?.title).toBe("After"));
});
