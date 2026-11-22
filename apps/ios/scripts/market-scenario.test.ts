import "../bridge/test-host.ts";
import { afterEach, expect, test } from "vitest";
import { NativeMarket, NativeMarketRequest } from "../bridge/market.ts";
import { sheetFixture, until } from "../bridge/sheet-fixture.ts";
import { seedMarket } from "./market-scenario.ts";

/* The spike's Marketplace, read through the phone's bridge as the app reads it. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

type Row = { id: string; typeWord: string; byAce: boolean; action: { word: string | null } };

test("the spike's marketplace fills every shelf of the phone's home", async () => {
  const { daemon, client } = sheetFixture();
  const now = Date.UTC(2026, 10, 21, 15, 0);
  seedMarket(daemon, now);
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const market = new NativeMarket(
    client,
    () => now,
    async () => {},
  );
  const ask = async (operation: Record<string, unknown>) =>
    (await market.answer(
      NativeMarketRequest.parse({ type: "market.native", operation }),
      new AbortController().signal,
    )) as Record<string, unknown>;

  const discover = await ask({ op: "discover" });
  expect(discover).toMatchObject({ ok: true, empty: false, hero: { title: "Inbox" } });
  for (const shelf of ["featured", "trending", "fresh", "collections", "publishers"])
    expect((discover[shelf] as unknown[]).length).toBeGreaterThan(0);
  const rows = [
    ...(discover.featured as Row[]),
    ...(discover.trending as Row[]),
    ...(discover.fresh as Row[]),
  ];
  // Every type, from ace and from a verified publisher.
  const listed = (await ask({ op: "search", query: "" })).rows as Row[];
  for (const type of ["Bot", "Skill", "Plugin", "Suit"])
    for (const fromAce of [true, false])
      expect(listed).toContainEqual(expect.objectContaining({ typeWord: type, byAce: fromAce }));
  expect(rows.find((row) => row.id === "market/spade-skill/triage-mail")?.action.word).toBe(
    "Update",
  );

  const home = await ask({ op: "home" });
  expect(home.categories).toEqual([
    expect.objectContaining({ title: "Mail" }),
    expect.objectContaining({ title: "Work" }),
  ]);
  const installed = await ask({ op: "installed" });
  expect(installed.rows).toEqual([
    expect.objectContaining({ title: "Triage mail", status: "Update to 1.2.0" }),
    expect.objectContaining({ title: "Old sorter", status: "Off: Replaced by Triage mail." }),
  ]);
  expect(await ask({ op: "publisher", handle: "harbour-co" })).toMatchObject({
    ok: true,
    name: "Harbour Co",
  });
});
