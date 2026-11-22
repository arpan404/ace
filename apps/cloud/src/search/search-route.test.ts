import { afterEach, describe, expect, it, vi } from "vitest";
import { grantPublicKey, signCloudGrant, signGrant } from "@ace/account-grant";
import type { Principal } from "../account/principal.ts";
import { sqliteD1 } from "../testing/sqlite-d1.ts";
import { searchCounters } from "./counters.ts";
import { DEFAULT_LIMITS, readLimits } from "./limits.ts";
import type { SearchLimits } from "./limits.ts";
import { repeatGuard } from "./repeats.ts";
import { searchRoutes } from "./route.ts";

/*
 * ace search's route (ADR 0210) against a real SQLite with the Worker's migrations, and a fake
 * Workers AI binding: Cloudflare's API is never called.
 */

const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const START = Date.UTC(2026, 10, 21, 12, 0, 0);
const DAY = 86_400_000;
const MACHINE_TOKEN = "m".repeat(43);
const SESSION_TOKEN = "s".repeat(43);
const ORG_TOKEN = "o".repeat(43);
const HOST_A = "A".repeat(52);
const HOST_B = "B".repeat(52);

type Asked = { gatewayId: string; query: string; provider?: string; limit?: number };
type Answer = (asked: Asked) => Response | Promise<Response>;

const items = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://docs.example/page-${i}`,
    title: `Page ${i}`,
    description: `About page ${i}`,
  }));
const ok = (body: unknown) => Response.json(body);

function world(
  options: { limits?: Partial<SearchLimits>; answer?: Answer; ai?: false; burst?: number } = {},
) {
  const { db, sqlite } = sqliteD1();
  let clock = START;
  const asked: Asked[] = [];
  const logs: string[] = [];
  let answer: Answer = options.answer ?? (() => ok({ items: items(3), metadata: {} }));
  // The bindings' per-minute counts, as Cloudflare keeps them: a count per key per minute.
  const minute = new Map<string, number>();
  const over = (name: string, cap: number) => async (k: string) => {
    const id = `${name}:${k}:${Math.floor(clock / 60_000)}`;
    const next = (minute.get(id) ?? 0) + 1;
    minute.set(id, next);
    return next > cap;
  };
  const machine = (account: string, hostId: string, org?: string): Principal => ({
    kind: "machine",
    hash: "h",
    hostId,
    ...(org ? { org } : {}),
    account: { id: account, email: `${account}@example.com`, name: account },
    expiresAt: clock + DAY,
    signedInAt: 0,
    standing: "exposed",
  });
  const routes = searchRoutes({
    keys: { keys: [grantPublicKey(key)] },
    principals: {
      read: async (token) => {
        if (token === MACHINE_TOKEN) return machine("user_ann", HOST_A);
        if (token === ORG_TOKEN) return machine("org_principal", HOST_A, "org_01ACME");
        if (token === SESSION_TOKEN)
          return { ...machine("user_ann", HOST_A), kind: "session" } as Principal;
        return undefined;
      },
    },
    counters: searchCounters(db),
    ai:
      options.ai === false
        ? undefined
        : {
            gatewayId: "ace-search",
            binding: {
              websearch: async (request) => {
                asked.push(request);
                return answer(request);
              },
            },
          },
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    repeats: repeatGuard({ now: () => clock, salt: new Uint8Array(32).fill(1) }),
    now: () => clock,
    addressOf: (request) => request.headers.get("CF-Connecting-IP") ?? "unknown",
    addressSalt: "salt",
    burst: { address: over("address", 30), account: over("account", options.burst ?? 10) },
    log: (entry) => logs.push(JSON.stringify(entry)),
  });
  /** A cloud credential for `account` on machine `host`, as Spade shows the broker. */
  const grant = (account = "user_ann", host = HOST_A) =>
    signCloudGrant(
      { kind: "machine", account, subject: host, iat: clock, exp: clock + 5 * 60_000 },
      key,
    );
  const search = (
    body: unknown,
    init: { token?: string; ip?: string; headers?: Record<string, string> } = {},
  ) =>
    routes.search(
      new Request("https://cloud.example/v1/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": init.ip ?? "203.0.113.7",
          ...(init.token === "" ? {} : { Authorization: `Bearer ${init.token ?? grant()}` }),
          ...init.headers,
        },
        body: JSON.stringify(body),
      }),
    );
  const usage = (token = grant()) =>
    routes.usage(
      new Request("https://cloud.example/v1/search/usage", {
        headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": "203.0.113.7" },
      }),
    );
  /** Registers `account`'s first machine at `at`, which makes the account that old. */
  const registered = (account: string, at: number) =>
    sqlite
      .prepare(
        "INSERT INTO machines (host_id, account_id, name, platform, created_at, last_seen_at) VALUES (?, ?, 'mac', 'darwin', ?, ?)",
      )
      .run(`${account}-host`, account, at, at);
  registered("user_ann", START - 60 * DAY);
  registered("user_ben", START - 60 * DAY);
  return {
    sqlite,
    asked,
    logs,
    search,
    usage,
    grant,
    registered,
    answerWith: (next: Answer) => (answer = next),
    advance: (ms: number) => (clock += ms),
    at: () => clock,
  };
}

/** Distinct queries, so the repeat check stays out of a test about counts. */
let n = 0;
const fresh = () => ({ query: `how do workers bind d1 ${n++}` });

async function refusal(response: Response) {
  const body = (await response.json()) as { error: string; reason: string; retryAfter: number };
  return {
    status: response.status,
    retryAfterHeader: response.headers.get("Retry-After"),
    ...body,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("who may search", () => {
  it("answers a Spade's cloud credential and a machine credential, with source links", async () => {
    const w = world();
    for (const token of [w.grant(), MACHINE_TOKEN]) {
      const response = await w.search(fresh(), { token });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { results: unknown[]; provider: string };
      expect(body.provider).toBe("ceramic");
      expect(body.results[0]).toEqual({
        url: "https://docs.example/page-0",
        title: "Page 0",
        snippet: "About page 0",
        site: "docs.example",
      });
    }
  });

  it("refuses no credential, a bad or expired one, a browser session, an org host and any Origin", async () => {
    const w = world();
    const expired = signCloudGrant(
      { kind: "machine", account: "user_ann", subject: HOST_A, iat: 0, exp: 1000 },
      key,
    );
    // A general machine grant isn't a cloud credential.
    const general = signGrant(
      { kind: "machine", account: "user_ann", subject: HOST_A, iat: w.at(), exp: w.at() + 60_000 },
      key,
    );
    expect((await w.search(fresh(), { token: "" })).status).toBe(401);
    expect((await w.search(fresh(), { token: "x".repeat(43) })).status).toBe(401);
    expect((await w.search(fresh(), { token: expired })).status).toBe(401);
    expect((await w.search(fresh(), { token: general })).status).toBe(401);
    expect((await w.search(fresh(), { token: SESSION_TOKEN })).status).toBe(403);
    expect((await w.search(fresh(), { token: ORG_TOKEN })).status).toBe(403);
    const browser = await w.search(fresh(), { headers: { Origin: "https://app.acehq.dev" } });
    expect(browser.status).toBe(403);
    expect(w.asked).toHaveLength(0);
  });

  it("answers search_unavailable until the AI binding and gateway are configured", async () => {
    const w = world({ ai: false });
    const response = await w.search(fresh());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "search_unavailable" });
  });
});

describe("Ceramic", () => {
  it("is asked by name through the gateway's credits, never with a key alias", async () => {
    const w = world();
    await w.search({ query: "  zod 4 discriminated union  ", limit: 4 });
    expect(w.asked).toEqual([
      {
        gatewayId: "ace-search",
        query: "zod 4 discriminated union",
        provider: "ceramic",
        limit: 4,
      },
    ]);
  });

  it("failing is a clean 502 with no other provider tried, and the search isn't counted", async () => {
    const w = world();
    const failures: Answer[] = [
      () => new Response("upstream", { status: 500 }),
      () => new Response("not json"),
      () => {
        throw new Error("binding down");
      },
    ];
    for (const failure of failures) {
      w.answerWith(failure);
      const response = await w.search(fresh());
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "search_failed" });
    }
    expect(w.asked.map((asked) => asked.provider)).toEqual(["ceramic", "ceramic", "ceramic"]);
    const usage = (await (await w.usage()).json()) as { month: { used: number } };
    expect(usage.month.used).toBe(0);
  });

  it("bounds the answer: ten results at most, fields cut, odd items dropped, huge answers refused", async () => {
    const w = world();
    w.answerWith(() =>
      ok({
        items: [
          { url: "javascript:alert(1)", title: "no" },
          { title: "no url" },
          "not an item",
          { url: "https://a.example/x", title: "t".repeat(5000), description: "d".repeat(5000) },
          ...items(40),
        ],
        extra: { kept: "ignored" },
      }),
    );
    const body = (await (await w.search(fresh())).json()) as {
      results: { url: string; title: string; snippet: string }[];
    };
    expect(body.results).toHaveLength(10);
    expect(body.results[0]?.url).toBe("https://a.example/x");
    expect(body.results[0]?.title).toHaveLength(300);
    expect(body.results[0]?.snippet).toHaveLength(500);
    expect(body.results.every((result) => result.url.startsWith("https://"))).toBe(true);

    w.answerWith(() => ok({ items: [{ url: "https://a.example/", title: "x".repeat(300_000) }] }));
    expect((await w.search(fresh())).status).toBe(502);
  });

  it("drops results older than the freshness asked for, and keeps undated ones", async () => {
    const w = world();
    w.answerWith(() =>
      ok({
        items: [
          { url: "https://a.example/old", title: "old", lastModifiedDate: "2025-01-01T00:00:00" },
          { url: "https://a.example/new", title: "new", lastModifiedDate: "2026-11-20T09:00:00" },
          { url: "https://a.example/undated", title: "undated" },
        ],
      }),
    );
    const body = (await (await w.search({ ...fresh(), freshness: "week" })).json()) as {
      results: { title: string }[];
    };
    expect(body.results.map((result) => result.title)).toEqual(["new", "undated"]);
  });
});

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
    const usage = (await (await w.usage()).json()) as { month: { used: number } };
    expect(usage.month.used).toBe(1);
  });

  it("the daily cap trips with a plain reason and Retry-After, and comes back the next day", async () => {
    const w = world({ limits: { daily: 3 } });
    for (let i = 0; i < 3; i++) expect((await w.search(fresh())).status).toBe(200);
    const refused = await refusal(await w.search(fresh()));
    expect(refused).toMatchObject({
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
    const w = world({ limits: { monthly: 2, daily: 100 } });
    for (let i = 0; i < 2; i++) expect((await w.search(fresh())).status).toBe(200);
    expect((await refusal(await w.search(fresh()))).error).toBe("monthly_spent");
    w.advance(5 * DAY);
    expect((await refusal(await w.search(fresh()))).error).toBe("monthly_spent");
    // 2026-12-01: a new month.
    w.advance(Date.UTC(2026, 11, 1) - w.at());
    expect((await w.search(fresh())).status).toBe(200);
  });

  it("gives a new account the smaller allowance for its first days", async () => {
    const w = world({ limits: { monthly: 10, newAccountMonthly: 2, newAccountDays: 7 } });
    w.registered("user_new", w.at() - DAY);
    const token = w.grant("user_new", HOST_B);
    for (let i = 0; i < 2; i++) expect((await w.search(fresh(), { token })).status).toBe(200);
    expect((await refusal(await w.search(fresh(), { token }))).error).toBe("monthly_spent");
    const usage = (await (await w.usage(token)).json()) as { month: { allowance: number } };
    expect(usage.month.allowance).toBe(2);
    // A week on, the account has the whole allowance.
    w.advance(7 * DAY);
    expect((await w.search(fresh(), { token: w.grant("user_new", HOST_B) })).status).toBe(200);
  });

  it("caps a stolen machine credential on its own, leaving the account's other machines searching", async () => {
    const w = world({ limits: { machineDaily: 3, daily: 100 } });
    for (let i = 0; i < 3; i++)
      expect((await w.search(fresh(), { token: MACHINE_TOKEN })).status).toBe(200);
    const refused = await refusal(await w.search(fresh(), { token: MACHINE_TOKEN }));
    expect(refused.error).toBe("machine_spent");
    // A grant naming the same machine is the same machine.
    expect(
      (await refusal(await w.search(fresh(), { token: w.grant("user_ann", HOST_A) }))).error,
    ).toBe("machine_spent");
    expect((await w.search(fresh(), { token: w.grant("user_ann", HOST_B) })).status).toBe(200);
  });

  it("caps one address across accounts, so sign-ups from one place don't multiply the allowance", async () => {
    const w = world({ limits: { addressDaily: 3 } });
    w.registered("user_cat", w.at() - 60 * DAY);
    const accounts = ["user_ann", "user_ben", "user_cat"];
    for (const [i, account] of accounts.entries())
      expect(
        (await w.search(fresh(), { token: w.grant(account, `${"C".repeat(51)}${i}`) })).status,
      ).toBe(200);
    const refused = await refusal(
      await w.search(fresh(), { token: w.grant("user_ann", "D".repeat(52)) }),
    );
    expect(refused.error).toBe("address_spent");
    expect((await w.search(fresh(), { ip: "198.51.100.9" })).status).toBe(200);
  });

  it("the spend breaker rests every account for the day once the dollars are spent", async () => {
    // $0.001 is four searches at $0.25 per 1,000.
    const limits = readLimits({ ACE_SEARCH_DAILY_DOLLARS: "0.001" });
    expect(limits.globalDaily).toBe(4);
    const w = world({ limits: { globalDaily: limits.globalDaily } });
    for (let i = 0; i < 4; i++)
      expect(
        (
          await w.search(fresh(), {
            token: w.grant(i % 2 ? "user_ben" : "user_ann", `${"E".repeat(51)}${i}`),
            ip: `198.51.100.${i}`,
          })
        ).status,
      ).toBe(200);
    for (const account of ["user_ann", "user_ben"]) {
      const refused = await refusal(
        await w.search(fresh(), { token: w.grant(account, "F".repeat(52)), ip: "192.0.2.1" }),
      );
      expect(refused).toMatchObject({ error: "resting", reason: "ace search is resting today." });
    }
    w.advance(DAY);
    expect((await w.search(fresh())).status).toBe(200);
  });

  it("a refused search takes nothing from the other counters", async () => {
    const w = world({ limits: { machineDaily: 1, daily: 5 } });
    expect((await w.search(fresh(), { token: MACHINE_TOKEN })).status).toBe(200);
    for (let i = 0; i < 3; i++)
      expect((await w.search(fresh(), { token: MACHINE_TOKEN })).status).toBe(429);
    const usage = (await (await w.usage()).json()) as { day: { used: number } };
    expect(usage.day.used).toBe(1);
  });

  it("refuses a burst over ten a minute per account, and answers again a minute on", async () => {
    const w = world();
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
    const usage = (await (await w.usage()).json()) as { month: { used: number } };
    expect(usage.month.used).toBe(4);
  });

  it("holds under concurrent searches: exactly the cap get through and the count matches", async () => {
    const w = world({ limits: { daily: 7 }, burst: 1000 });
    const tokens = Array.from({ length: 40 }, (_, i) =>
      w.grant("user_ann", `${"G".repeat(50)}${String(i).padStart(2, "0")}`),
    );
    const statuses = await Promise.all(
      tokens.map((token, i) =>
        w.search(fresh(), { token, ip: `198.51.100.${i}` }).then((response) => response.status),
      ),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(7);
    expect(statuses.filter((status) => status === 429)).toHaveLength(33);
    const row = w.sqlite
      .prepare("SELECT count FROM search_counts WHERE scope = 'account:user_ann' AND period = ?")
      .get(new Date(w.at()).toISOString().slice(0, 10)) as { count: number };
    expect(row.count).toBe(7);
  });
});

describe("privacy", () => {
  it("never stores or logs the query text, only counts", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const w = world({ limits: { daily: 2 } });
    const secret = "patient-4417 lab results interpretation";
    await w.search({ query: secret });
    w.answerWith(() => new Response("down", { status: 503 }));
    await w.search({ query: `${secret} again` });
    w.answerWith(() => ok({ items: items(1) }));
    await w.search({ query: `${secret} three` });
    await w.search({ query: `${secret} four` });
    const stored: string[] = [];
    const tables = w.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables)
      stored.push(JSON.stringify(w.sqlite.prepare(`SELECT * FROM "${name}"`).all()));
    const everything = [...stored, ...w.logs, ...lines].join("\n");
    expect(everything).not.toContain("patient-4417");
    expect(everything).not.toContain("lab results");
    // Nor the caller's address: its counter is a salted digest.
    expect(everything).not.toContain("203.0.113.7");
    expect(w.logs.length).toBeGreaterThan(0);
  });
});
