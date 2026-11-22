import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { searchCounters } from "./counters.ts";
import { dayOf } from "./limits.ts";
import type { Counter } from "./limits.ts";

/*
 * ace search's counter statements on D1 itself (workerd's local D1, not node:sqlite): the
 * all-or-nothing take, the give-back and the live-machine check are SQL the unit tests run on
 * SQLite; this proves D1 runs them the same way.
 */

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ ACCOUNTS: D1Database }>>>;
const NOW = Date.UTC(2026, 10, 21, 12);

beforeAll(async () => {
  proxy = await getPlatformProxy<{ ACCOUNTS: D1Database }>({
    configPath: join(import.meta.dirname, "../../wrangler.jsonc"),
    persist: false,
  });
  const dir = join(import.meta.dirname, "../../migrations");
  for (const file of readdirSync(dir).toSorted())
    for (const statement of readFileSync(join(dir, file), "utf8")
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean))
      await proxy.env.ACCOUNTS.prepare(statement).run();
}, 30_000);
afterAll(() => proxy?.dispose());

it("takes every counter or none on D1, and gives back in one statement", async () => {
  const counters = searchCounters(proxy.env.ACCOUNTS);
  const day = dayOf(NOW);
  const wanted = (cap: number): Counter[] => [
    { scope: "global", period: day, cap: 100, refusal: "resting" },
    { scope: "account:user_ann", period: day, cap, refusal: "daily_spent" },
  ];
  expect(await counters.take(wanted(2))).toEqual({ taken: true, counts: [1, 1] });
  expect(await counters.take(wanted(2))).toEqual({ taken: true, counts: [2, 2] });
  const refused = await counters.take(wanted(2));
  expect(refused).toMatchObject({ taken: false, full: { refusal: "daily_spent" } });
  // The refusal took nothing from the global counter either.
  expect(await counters.read(wanted(2))).toEqual([2, 2]);
  await counters.giveBack(wanted(2));
  expect(await counters.read(wanted(2))).toEqual([1, 1]);
});

it("knows a live machine on D1, and forgets it once its credential is revoked", async () => {
  const db = proxy.env.ACCOUNTS;
  const host = "A".repeat(52);
  await db
    .prepare(
      "INSERT INTO sessions (token, account, refresh, expires, standing) VALUES ('s1', ?, 'sealed', ?, 'exposed')",
    )
    .bind(JSON.stringify({ id: "user_ann", email: "ann@example.com" }), NOW + 86_400_000)
    .run();
  await db
    .prepare(
      "INSERT INTO machine_credentials (token, session, host_id, account_id, expires, created_at) VALUES ('c1', 's1', ?, 'user_ann', ?, ?)",
    )
    .bind(host, NOW + 86_400_000, NOW)
    .run();
  const counters = searchCounters(db);
  expect(await counters.machineLive("user_ann", host, NOW)).toBe(true);
  expect(await counters.machineLive("user_ben", host, NOW)).toBe(false);
  await db.prepare("DELETE FROM machine_credentials WHERE token = 'c1'").run();
  expect(await counters.machineLive("user_ann", host, NOW)).toBe(false);
});
