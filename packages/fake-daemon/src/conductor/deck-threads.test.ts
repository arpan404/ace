import { expect, test } from "vitest";
import { Client, ConductorClient } from "@ace/client";
import { DeviceId, InteractionId, InteractionResolution, ThreadId } from "@ace/protocol";
import { stagedDeck } from "./decks.ts";
import { FakeDaemon, fakeTransport, workbenchServices } from "../index.ts";

async function connected() {
  const now = 1_800_000_000_000;
  const daemon = new FakeDaemon({ clock: () => now });
  daemon.seedServices(workbenchServices(now));
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `read-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state !== "ready") return;
      stop();
      resolve();
    });
  });
  await client.start();
  await ready;
  return { daemon, client, decks: new ConductorClient(client, () => `watch-${++sequence}`) };
}

const resolve = (client: Client, interactionId: string, resolution: InteractionResolution) =>
  client.command({
    type: "interaction.resolve",
    interactionId: InteractionId.parse(interactionId),
    resolution,
  });

test("a worker's question is a provider gate answered through its own thread", async () => {
  const { client, decks } = await connected();
  try {
    const before = await decks.get("mobile-cold-start");
    const gate = before.needsUser.find((entry) => entry.kind === "provider");
    if (!gate?.interactionId || !gate.threadId) throw new Error("Question gate missing");
    expect(gate).toMatchObject({
      workstream: "hermes-bytecode",
      threadId: "mobile-cold-start.hermes-bytecode.thread",
      message: "question needs your answer",
    });
    // A conductor decision can't answer it: it belongs to the worker's thread.
    expect(
      await client.command({
        type: "conductor.approve",
        runId: "mobile-cold-start",
        approval: { gateId: gate.id, decision: "approve" },
      }),
    ).toMatchObject({ ok: false, error: "stale_gate" });

    expect(
      await resolve(client, gate.interactionId, {
        kind: "question",
        answers: { choice: ["apk"] },
      }),
    ).toMatchObject({ ok: true });

    const after = await decks.get("mobile-cold-start");
    expect(after.needsUser.map((entry) => entry.kind)).toEqual(["escalation"]);
  } finally {
    await client.close();
  }
});

test("a deck gate answered on the deck's own thread is the conductor's decision", async () => {
  const { daemon, client, decks } = await connected();
  try {
    daemon.seedServices({ decks: [stagedDeck("planning", 1_800_000_000_000)] });
    const gate = (await decks.get("search-ranking")).needsUser[0];
    if (!gate) throw new Error("Plan gate missing");
    const root = daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse("search-ranking.root"),
    });
    expect(root && "thread" in root ? root.thread.deck : undefined).toMatchObject({
      deckId: "search-ranking",
      runId: "search-ranking",
      role: "root",
    });
    const interactions = root && "interactions" in root ? Object.values(root.interactions) : [];
    const mirrored = interactions.find((interaction) => interaction.state === "pending");
    expect(mirrored?.raw[0]?.type).toBe("ace.conductor.gate");
    if (!mirrored) throw new Error("Mirrored gate missing");

    expect(
      await resolve(client, mirrored.id, { kind: "plan_review", decision: "approve" }),
    ).toMatchObject({ ok: true });

    const after = await decks.get("search-ranking");
    expect(after.needsUser).toEqual([]);
    expect(after.planApproved).toBe(true);
  } finally {
    await client.close();
  }
});

test("a deck the conductor couldn't run reports why until it is resumed", async () => {
  const { daemon, client, decks } = await connected();
  try {
    daemon.failDeck("mobile-cold-start", "deck_workspace_not_found");
    expect((await decks.get("mobile-cold-start")).executionError).toBe("deck_workspace_not_found");

    expect(
      await client.command({ type: "conductor.resume", runId: "mobile-cold-start" }),
    ).toMatchObject({ ok: true });
    expect((await decks.get("mobile-cold-start")).executionError).toBeUndefined();
  } finally {
    await client.close();
  }
});

test("a non-plan gate stays in the Deck UI and cancelling closes a worker's question", async () => {
  const { daemon, client, decks } = await connected();
  try {
    const run = await decks.get("mobile-cold-start");
    const provider = run.needsUser.find((gate) => gate.kind === "provider");
    if (!provider?.threadId) throw new Error("Missing provider question");
    const root = daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse("mobile-cold-start.root"),
    });
    expect(
      root && "interactions" in root
        ? Object.values(root.interactions).filter((entry) => entry.state === "pending")
        : [],
    ).toEqual([]);
    expect(await client.command({ type: "conductor.cancel", runId: run.id })).toMatchObject({
      ok: true,
    });
    await decks.get(run.id);
    const worker = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(provider.threadId) });
    expect(
      worker && "interactions" in worker
        ? Object.values(worker.interactions).filter((entry) => entry.state === "pending")
        : [],
    ).toEqual([]);
  } finally {
    await client.close();
  }
});
