import { ConductorClient, type ThreadReader, type ThreadSource } from "@ace/client";
import { ScenarioPlayer, flakyCheckout, workbenchServices } from "@ace/fake-daemon";
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

test("a deck worker's question stays visible to overlapping subscribers and after either leaves", async () => {
  const { daemon, tab } = world();
  daemon.seedServices(workbenchServices(1_800_000_000_000));
  const client = tab();
  await client.start();
  let ids = 0;
  const decks = new ConductorClient(client, () => `deck-${++ids}`);
  const run = await decks.get("mobile-cold-start");
  const gate = run.needsUser.find((entry) => entry.kind === "provider");
  if (!gate?.threadId || !gate.interactionId) throw new Error("Missing worker question");
  // Activity mounts its waiting-time reporters before the deck's lazy question card.
  const reporting = run.delegations
    .filter((entry) => entry.threadId !== gate.threadId)
    .slice(0, 4)
    .map((entry) => client.thread(entry.threadId));
  cleanups.push(() => reporting.forEach((lease) => lease.release()));
  const first = client.thread(gate.threadId);
  const left = watch(first.store);
  const second = client.thread(gate.threadId);
  const right = watch(second.store);
  await vi.waitFor(() => {
    expect(left.read()).toMatchObject([{ state: "pending", request: { kind: "question" } }]);
    expect(right.read()).toEqual(left.read());
  });
  expect(first.store.thread?.deck?.role).toBe("worker");
  await client.request({ type: "diagnostics.health" });
  expect(left.read()).toEqual(right.read());
  expect(right.read()).toMatchObject([{ id: gate.interactionId, request: { kind: "question" } }]);
  left.stop();
  first.release();
  await client.request({ type: "diagnostics.health" });
  expect(right.read()).toMatchObject([{ id: gate.interactionId, state: "pending" }]);
  const returning = client.thread(gate.threadId);
  const returned = watch(returning.store);
  expect(returned.read()).toEqual(right.read());
  right.stop();
  second.release();
  await client.request({ type: "diagnostics.health" });
  expect(returned.read()).toMatchObject([{ id: gate.interactionId, state: "pending" }]);
  expect(
    await client.command({
      type: "interaction.resolve",
      interactionId: InteractionId.parse(gate.interactionId),
      resolution: { kind: "question", answers: { choice: ["apk"] } },
    }),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(returned.read()).toEqual([]));
  returned.stop();
  returning.release();
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
  await client.request({ type: "diagnostics.health" });
  expect(left.read()).toEqual(expected);
  left.stop();
  first.release();
  await client.request({ type: "diagnostics.health" });
  const resumed = client.thread(script.threadId);
  const visible = watch(resumed.store);
  await vi.waitFor(() => expect(visible.read()).toEqual(expected));
  const approval = expected[0];
  if (approval?.request.kind !== "approval") throw new Error("Missing approval");
  const option = approval.request.options.find((entry) => entry.kind === "allow_once");
  if (!option) throw new Error("Missing approval option");
  expect(
    await client.command({
      type: "interaction.resolve",
      interactionId: approval.id,
      resolution: { kind: "approval", optionId: option.id },
    }),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(visible.read()).toEqual([]));
  visible.stop();
  resumed.release();
});

test("a complete snapshot admits queued threads while reconnect replay still waits for completion", async () => {
  const { daemon, tab, faults } = world();
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
  const complete: (() => void)[] = [];
  faults.incoming = (message, text, deliver) => {
    deliver(text);
    // The transport holds the daemon's replay-completion acknowledgements independently
    // of replay data, which can span several batches on the real daemon.
    if (message.type === "events")
      complete.push(() =>
        deliver(
          JSON.stringify({
            type: "subscription.ready",
            subscriptionId: message.subscriptionId,
            seq: message.throughSeq,
          }),
        ),
      );
  };
  client.networkOnline(true);
  await vi.waitFor(() => expect(held[3]?.store.thread?.title).toBe("After"));
  await client.request({ type: "diagnostics.health" });
  expect(held[4]?.store.thread?.title).toBe("Before");
  const release = complete.shift();
  if (!release) throw new Error("Missing replay completion");
  release();
  await vi.waitFor(() => expect(held[4]?.store.thread?.title).toBe("After"));
});
