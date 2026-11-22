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

/** A live machine as the account backend keeps one: a session and a credential on it. */
async function liveMachine(account: string, host: string, session: string, credential: string) {
  const db = proxy.env.ACCOUNTS;
  await db
    .prepare(
      "INSERT INTO sessions (token, account, refresh, expires, standing, retired) VALUES (?, ?, 'sealed', ?, 'exposed', 1)",
    )
    .bind(
      session,
      JSON.stringify({ id: account, email: `${account}@example.com` }),
      NOW + 86_400_000,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO machine_credentials (token, session, host_id, account_id, expires, created_at, sole) VALUES (?, ?, ?, ?, ?, ?, 1)",
    )
    .bind(credential, session, host, account, NOW + 86_400_000, NOW)
    .run();
  return { account, machine: host, now: NOW };
}

it("takes every counter or none on D1, and gives back in one statement", async () => {
  const counters = searchCounters(proxy.env.ACCOUNTS);
  const holder = await liveMachine("user_cat", "C".repeat(52), "s0", "c0");
  const day = dayOf(NOW);
  const wanted = (cap: number): Counter[] => [
    { scope: "global", period: day, cap: 100, refusal: "resting" },
    { scope: "account:user_ann", period: day, cap, refusal: "daily_spent" },
  ];
  expect(await counters.take(wanted(2), holder)).toEqual({ taken: true, counts: [1, 1] });
  expect(await counters.take(wanted(2), holder)).toEqual({ taken: true, counts: [2, 2] });
  const refused = await counters.take(wanted(2), holder);
  expect(refused).toMatchObject({
    taken: false,
    machineGone: false,
    full: { refusal: "daily_spent" },
  });
  // The refusal took nothing from the global counter either.
  expect(await counters.read(wanted(2))).toEqual([2, 2]);
  await counters.giveBack(wanted(2));
  expect(await counters.read(wanted(2))).toEqual([1, 1]);
});

it("knows a live machine on D1, its session's token retired by a sole exchange, until revoked", async () => {
  const db = proxy.env.ACCOUNTS;
  const host = "A".repeat(52);
  await liveMachine("user_ann", host, "s1", "c1");
  const counters = searchCounters(db);
  expect(await counters.machineLive("user_ann", host, NOW)).toBe(true);
  expect(await counters.machineLive("user_ben", host, NOW)).toBe(false);
  await db.prepare("DELETE FROM machine_credentials WHERE token = 'c1'").run();
  expect(await counters.machineLive("user_ann", host, NOW)).toBe(false);
  // Gone, the machine takes no counter either.
  const day = dayOf(NOW);
  expect(
    await counters.take([{ scope: "global", period: day, cap: 100, refusal: "resting" }], {
      account: "user_ann",
      machine: host,
      now: NOW,
    }),
  ).toEqual({ taken: false, machineGone: true });
});
