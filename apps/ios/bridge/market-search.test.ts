import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { NativeMarket, NativeMarketRequest } from "./market.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";

/* Search past its first page, and a category's reviewed rows, on the fake daemon's market. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const listing = (name: string, reviewed: boolean) => ({
  summary: {
    source: "market",
    type: "spade-skill",
    name,
    title: name,
    line: `${name} in one line`,
    categories: ["mail"],
    keywords: [],
    version: "1.0.0",
    reviewed,
    byAce: false,
    updated: 1,
    downloads: 3,
    supported: true,
  },
});

/** 120 skills in Mail, every other one reviewed. */
async function market() {
  const { daemon, client } = sheetFixture();
  const entries = Array.from({ length: 120 }, (_, n) =>
    listing(`skill-${String(n).padStart(3, "0")}`, n % 2 === 0),
  );
  daemon.seedServices({
    marketplace: { entries, categories: [{ id: "mail", title: "Mail" }], readAt: 5_000 },
  });
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const service = new NativeMarket(client, () => 6_000);
  const ask = async (operation: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    (await service.answer(
      NativeMarketRequest.parse({ type: "market.native", operation, ...extra }),
      new AbortController().signal,
    )) as { ok: boolean; rows: { name: string; reviewed: boolean }[]; next: number | null };
  return { ask };
}

test("search goes on past its first 50 results, and says when there are no more", async () => {
  const { ask } = await market();
  const first = await ask({ op: "search", query: "" });
  expect(first.rows).toHaveLength(50);
  expect(first.next).toBe(50);
  const second = await ask({ op: "search", query: "", offset: 50 });
  const third = await ask({ op: "search", query: "", offset: 100 });
  expect(third.rows).toHaveLength(20);
  expect(third.next).toBeNull();
  const names = new Set([...first.rows, ...second.rows, ...third.rows].map((row) => row.name));
  expect(names.size).toBe(120);
});

test("a category's reviewed rows fill a whole page, though half its entries aren't reviewed", async () => {
  const { ask } = await market();
  const first = await ask({ op: "search", query: "", category: "mail" }, { reviewedOnly: true });
  expect(first.rows).toHaveLength(50);
  expect(first.rows.every((row) => row.reviewed)).toBe(true);
  expect(first.next).not.toBeNull();
  const rest = await ask(
    { op: "search", query: "", category: "mail", offset: first.next },
    { reviewedOnly: true },
  );
  expect(rest.rows.every((row) => row.reviewed)).toBe(true);
  expect(rest.next).toBeNull();
  const names = new Set([...first.rows, ...rest.rows].map((row) => row.name));
  expect(names.size).toBe(60);
});
