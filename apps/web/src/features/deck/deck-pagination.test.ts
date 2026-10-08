import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport, deckRuns, workbenchServices } from "@ace/fake-daemon";
import { DeckStore } from "./deck-store.ts";

test("sidebar and Needs you discover an old gated Deck beyond the first history page", async () => {
  const now = 1_800_000_000_000;
  const daemon = new FakeDaemon({ clock: () => now });
  const templates = deckRuns(now);
  const gated = templates.find((run) => run.id === "relay-streams");
  const finished = templates.find((run) => run.phase === "merged");
  if (!gated || !finished) throw new Error("Deck seeds missing");
  const history = Array.from({ length: 40 }, (_, index) => ({
    ...finished,
    id: `a-history-${index}`,
    title: `Finished ${index}`,
    updatedAt: now + index,
    createdAt: now + index,
  }));
  daemon.seedServices({
    ...workbenchServices(now),
    decks: [...history, { ...gated, id: "z-old-gated", updatedAt: 1, createdAt: 1 }],
  });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("sidebar"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `read-${++sequence}`,
  });
  const decks = new DeckStore(client, { id: () => `deck-${++sequence}`, every: () => () => {} });
  const loaded = Promise.withResolvers<void>();
  const stop = decks.subscribe(() => {
    const snapshot = decks.snapshot();
    if (snapshot.ready && snapshot.entries.length && snapshot.entries.every((entry) => entry.view))
      loaded.resolve();
  });
  try {
    await client.start();
    await loaded.promise;
    expect(
      decks.snapshot().entries.find((entry) => entry.summary.id === "z-old-gated")?.view
        ?.needsUser[0]?.kind,
    ).toBe("merge");
    await decks.more();
    const ids = decks.snapshot().entries.map((entry) => entry.summary.id);
    expect(new Set(ids).size).toBe(41);
    expect(ids).toHaveLength(41);
  } finally {
    stop();
    await client.close();
  }
});
