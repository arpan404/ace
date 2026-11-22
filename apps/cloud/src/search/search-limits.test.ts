import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, readLimits } from "./limits.ts";
import { DAY, HOST_A, HOST_B, fresh, host, refusal, used, world } from "./test-world.ts";

/*
 * ace search's limits (ADR 0210 §4), each tripping and coming back, held under concurrent
 * searches, and admission all or nothing.
 */

describe("limits", () => {
  it("reads its Worker vars, keeping the default for any unset or unreadable one", () => {
    expect(readLimits({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toMatchObject({ monthly: 1000, daily: 100, globalDaily: 20_000 });
    expect(
      readLimits({
        ACE_SEARCH_MONTHLY: "250",
        ACE_SEARCH_DAILY: "ten",
        ACE_SEARCH_DAILY_DOLLARS: "-1",
      }),
    ).toEqual({ ...DEFAULT_LIMITS, monthly: 250 });
  });

  it("caps the query's length and refuses a bad body before anything is counted", async () => {
    const w = world();
    expect((await w.search({ query: "q".repeat(400) })).status).toBe(200);
    expect((await w.search({ query: "q".repeat(401) })).status).toBe(400);
    expect((await w.search({ query: "   " })).status).toBe(400);
    expect((await w.search({ query: "x", limit: 50 })).status).toBe(400);
    expect(await used(await w.usage())).toBe(1);
  });

  it("the daily cap trips with a plain reason and Retry-After, and comes back the next day", async () => {
    const w = world({ limits: { daily: 3 } });
    for (let i = 0; i < 3; i++) expect((await w.search(fresh())).status).toBe(200);
    expect(await refusal(await w.search(fresh()))).toMatchObject({
      status: 429,
      error: "daily_spent",
      reason: "You've used today's ace searches. They come back tomorrow.",
      retryAfter: 12 * 3600,
      retryAfterHeader: String(12 * 3600),
    });
    w.advance(12 * 3600 * 1000);
    expect((await w.search(fresh())).status).toBe(200);
  });

  it("the monthly allowance trips and comes back on the 1st", async () => {
    const w = world({ limits: { monthly: 2 } });
    for (let i = 0; i < 2; i++) expect((await w.search(fresh())).status).toBe(200);
    expect((await refusal(await w.search(fresh()))).error).toBe("monthly_spent");
    w.advance(5 * DAY);
    expect((await refusal(await w.search(fresh()))).error).toBe("monthly_spent");
    w.advance(Date.UTC(2026, 11, 1) - w.at());
    expect((await w.search(fresh())).status).toBe(200);
  });

  it("gives a new account the smaller allowance for its first days", async () => {
    const w = world({ limits: { monthly: 10, newAccountMonthly: 2, newAccountDays: 7 } });
    w.registered("user_new", w.at() - DAY);
    for (let i = 0; i < 2; i++)
      expect((await w.search(fresh(), { token: w.spade("user_new", HOST_B) })).status).toBe(200);
    const refused = await refusal(await w.search(fresh(), { token: w.spade("user_new", HOST_B) }));
    expect(refused.error).toBe("monthly_spent");
    const usage = (await (await w.usage(w.spade("user_new", HOST_B))).json()) as {
      month: { allowance: number };
    };
    expect(usage.month.allowance).toBe(2);
    w.advance(7 * DAY);
    expect((await w.search(fresh(), { token: w.spade("user_new", HOST_B) })).status).toBe(200);
  });

  it("caps a stolen machine's credential on its own, leaving the account's other machines searching", async () => {
    const w = world({ limits: { machineDaily: 3 } });
    for (let i = 0; i < 3; i++)
      expect((await w.search(fresh(), { token: w.spade("user_ann", HOST_A) })).status).toBe(200);
    expect(
      (await refusal(await w.search(fresh(), { token: w.spade("user_ann", HOST_A) }))).error,
    ).toBe("machine_spent");
    expect((await w.search(fresh(), { token: w.spade("user_ann", HOST_B) })).status).toBe(200);
  });

  it("caps one address across accounts, so sign-ups from one place don't multiply the allowance", async () => {
    const w = world({ limits: { addressDaily: 3 } });
    for (const [i, account] of ["user_ann", "user_ben", "user_cat"].entries())
      expect((await w.search(fresh(), { token: w.spade(account, host(i)) })).status).toBe(200);
    const refused = await refusal(await w.search(fresh(), { token: w.spade("user_ann", host(9)) }));
    expect(refused.error).toBe("address_spent");
    expect((await w.search(fresh(), { ip: "198.51.100.9" })).status).toBe(200);
  });

  it("the spend breaker rests every account for the day once the dollars are spent", async () => {
    // $0.001 is four searches at $0.25 per 1,000.
    const limits = readLimits({ ACE_SEARCH_DAILY_DOLLARS: "0.001" });
    expect(limits.globalDaily).toBe(4);
    const w = world({ limits: { globalDaily: limits.globalDaily } });
    for (let i = 0; i < 4; i++) {
      const token = w.spade(i % 2 ? "user_ben" : "user_ann", host(i));
      expect((await w.search(fresh(), { token, ip: `198.51.100.${i}` })).status).toBe(200);
    }
    for (const account of ["user_ann", "user_ben", "user_cat"]) {
      const token = w.spade(account, host(20));
      const refused = await refusal(await w.search(fresh(), { token, ip: "192.0.2.1" }));
      expect(refused).toMatchObject({ error: "resting", reason: "ace search is resting today." });
    }
    w.advance(DAY);
    expect((await w.search(fresh())).status).toBe(200);
  });

  it("refuses a burst over the account's limit a minute, and answers again a minute on", async () => {
    const w = world({ accountBurst: 10 });
    for (let i = 0; i < 10; i++) expect((await w.search(fresh())).status).toBe(200);
    expect(await refusal(await w.search(fresh()))).toMatchObject({
      error: "search_busy",
      retryAfter: 60,
    });
    w.advance(60_000);
    expect((await w.search(fresh())).status).toBe(200);
  });

  it("refuses the same query asked a third time within a minute, without counting it", async () => {
    const w = world();
    const same = { query: "Rust  async traits" };
    expect((await w.search(same)).status).toBe(200);
    expect((await w.search({ query: "rust async TRAITS" })).status).toBe(200);
    expect((await refusal(await w.search(same))).error).toBe("repeated_query");
    expect((await w.search({ query: "rust async closures" })).status).toBe(200);
    w.advance(61_000);
    expect((await w.search(same)).status).toBe(200);
    expect(await used(await w.usage())).toBe(4);
  });
});

describe("admission is all or nothing", () => {
  it("a refused search writes nothing to any counter, even when the request is cut short after it", async () => {
    const w = world({ limits: { machineDaily: 1 } });
    expect((await w.search(fresh(), { token: w.spade("user_ann", HOST_A) })).status).toBe(200);
    const before = w.counts();
    for (let calls = 0; calls < 6; calls++) {
      // The Worker stops after `calls` D1 calls of this request: refused or failed, nothing moved.
      w.interrupt(calls + 1);
      await w.search(fresh(), { token: w.spade("user_ann", HOST_A) }).catch(() => undefined);
      w.interrupt(undefined);
      expect(w.counts()).toBe(before);
    }
  });

  it("holds under concurrent searches: exactly the cap get through and the counts match", async () => {
    const w = world({ limits: { daily: 7 }, accountBurst: 1000 });
    const tokens = Array.from({ length: 40 }, (_, i) => w.spade("user_ann", host(100 + i)));
    const statuses = await Promise.all(
      tokens.map((token, i) =>
        w.search(fresh(), { token, ip: `198.51.100.${i}` }).then((response) => response.status),
      ),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(7);
    expect(statuses.filter((status) => status === 429)).toHaveLength(33);
    const rows = w.sqlite
      .prepare("SELECT scope, count FROM search_counts WHERE period = ?")
      .all(new Date(w.at()).toISOString().slice(0, 10)) as { scope: string; count: number }[];
    expect(rows.find((row) => row.scope === "account:user_ann")?.count).toBe(7);
    expect(rows.find((row) => row.scope === "global")?.count).toBe(7);
    // No refused search left a count on its machine or address.
    const machines = rows.filter((row) => row.scope.startsWith("machine:"));
    expect(machines.reduce((sum, row) => sum + row.count, 0)).toBe(7);
  });
});
