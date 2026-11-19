import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import type { z } from "zod";
import type { MarketEntrySummary, MarketOperation } from "@ace/protocol/marketplace";
import { FakeDaemon, fakeTransport } from "./index.ts";

const entry = (
  type: string,
  name: string,
  extra: Partial<MarketEntrySummary> = {},
): MarketEntrySummary => ({
  source: "market",
  type,
  name,
  title: name,
  line: `${name} in one line`,
  categories: ["mail"],
  keywords: [],
  version: "1.0.0",
  reviewed: true,
  byAce: false,
  updated: 1,
  downloads: 3,
  supported: true,
  ...extra,
});

async function connect() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.seedServices({
    marketplace: {
      entries: [
        { summary: entry("spade-skill", "triage-mail") },
        { summary: entry("suit", "harbour-dusk", { title: "Harbour dusk" }) },
        { summary: entry("spade-bot", "inbox", { reviewed: false }) },
      ],
      featured: [
        { type: "suit", name: "harbour-dusk" },
        { type: "spade-bot", name: "inbox" },
      ],
      categories: [{ id: "mail", title: "Mail" }],
      refuse: { "spade-skill/blocked": "Not signed by ace's market" },
    },
  });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `market-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  const ask = async (operation: z.input<typeof MarketOperation>) =>
    (await client.request({ type: "marketplace.request", operation })).result;
  return { client, ask, close: () => client.close() };
}

test("the fake marketplace browses seeded entries, featuring only reviewed ones", async () => {
  const f = await connect();
  try {
    expect(await f.ask({ op: "home" })).toMatchObject({
      op: "home",
      featured: [expect.objectContaining({ name: "harbour-dusk" })],
      categories: [{ id: "mail", title: "Mail", entries: 2 }],
      installed: 0,
    });
    expect(await f.ask({ op: "search", query: "harbor", offset: 0, limit: 50 })).toMatchObject({
      entries: [expect.objectContaining({ name: "harbour-dusk" })],
      total: 1,
    });
  } finally {
    await f.close();
  }
});

test("a fake install needs its review's hash and moves the entry into Installed, with a change push", async () => {
  const f = await connect();
  const pushes: unknown[] = [];
  const stop = f.client.onMessage((message) => {
    if (message.type === "marketplace.changed") pushes.push(message);
  });
  try {
    const prepared = await f.ask({
      op: "prepare",
      source: "market",
      type: "spade-skill",
      name: "triage-mail",
    });
    if (prepared.op !== "review") throw new Error("Expected a review");
    const wrong = await f.ask({
      op: "install",
      id: prepared.review.id,
      hash: "0".repeat(64),
      choices: { bots: [], needs: {}, startRoutines: false },
    });
    expect(wrong).toMatchObject({ op: "error", code: "conflict" });
    const done = await f.ask({
      op: "install",
      id: prepared.review.id,
      hash: prepared.review.hash,
      choices: { bots: [], needs: {}, startRoutines: false },
    });
    expect(done).toMatchObject({ op: "done", installed: { name: "triage-mail", state: "on" } });
    expect(await f.ask({ op: "installed" })).toMatchObject({
      installed: [expect.objectContaining({ name: "triage-mail" })],
    });
    expect(pushes).toEqual([{ type: "marketplace.changed", installed: 1, updates: 0 }]);
    expect(
      await f.ask({ op: "prepare", source: "market", type: "spade-skill", name: "blocked" }),
    ).toMatchObject({
      op: "error",
      code: "refused",
    });
  } finally {
    stop();
    await f.close();
  }
});
