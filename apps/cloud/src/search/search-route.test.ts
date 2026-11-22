import { afterEach, describe, expect, it, vi } from "vitest";
import { signCloudGrant, signGrant } from "@ace/account-grant";
import {
  HOST_A,
  HOST_B,
  fresh,
  items,
  ok,
  refusal,
  used,
  world,
  wranglerLimit,
} from "./test-world.ts";
import type { Answer } from "./test-world.ts";

/* ace search's route (ADR 0210): who may search, what Ceramic costs, and what is never kept. */

const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };

afterEach(() => vi.restoreAllMocks());

describe("who may search", () => {
  it("answers a Spade's cloud credential on its live machine, with source links", async () => {
    const w = world();
    const response = await w.search(fresh(), { token: w.spade("user_ann", HOST_A) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[]; provider: string };
    expect(body.provider).toBe("ceramic");
    expect(body.results[0]).toEqual({
      url: "https://docs.example/page-0",
      title: "Page 0",
      snippet: "About page 0",
      site: "docs.example",
    });
  });

  it("refuses a grant for a machine the account holds no live machine credential for", async () => {
    const w = world();
    w.spade("user_ann", HOST_A);
    // As a browser session can mint for any host id through /v1/grants.
    const invented = await w.search(fresh(), { token: w.grant("user_ann", "Z".repeat(52)) });
    expect(invented.status).toBe(403);
    expect(await invented.json()).toEqual({ error: "machine_unknown" });
    // Another account's machine is not this account's.
    expect((await w.search(fresh(), { token: w.grant("user_ben", HOST_A) })).status).toBe(403);
    expect(w.asked).toHaveLength(0);
  });

  it("stops a still-valid grant at once when its machine credential is revoked or its session ends", async () => {
    const w = world();
    const grant = w.spade("user_ann", HOST_A);
    expect((await w.search(fresh(), { token: grant })).status).toBe(200);
    w.sqlite.prepare("DELETE FROM machine_credentials WHERE host_id = ?").run(HOST_A);
    expect((await w.search(fresh(), { token: grant })).status).toBe(403);

    const other = w.spade("user_ann", HOST_B);
    expect((await w.search(fresh(), { token: other })).status).toBe(200);
    w.sqlite.prepare("UPDATE sessions SET retired = 1 WHERE token LIKE ?").run(`%${HOST_B}`);
    expect((await w.search(fresh(), { token: other })).status).toBe(403);
  });

  it("refuses no credential, a bare machine credential, a bad, expired or general grant, and any Origin", async () => {
    const w = world();
    w.spade("user_ann", HOST_A);
    const expired = signCloudGrant(
      { kind: "machine", account: "user_ann", subject: HOST_A, iat: 0, exp: 1000 },
      key,
    );
    const general = signGrant(
      { kind: "machine", account: "user_ann", subject: HOST_A, iat: w.at(), exp: w.at() + 60_000 },
      key,
    );
    for (const token of ["", "x".repeat(43), "m".repeat(43), expired, general])
      expect((await w.search(fresh(), { token })).status).toBe(401);
    const browser = await w.search(fresh(), { headers: { Origin: "https://app.acehq.dev" } });
    expect(browser.status).toBe(403);
    expect(w.asked).toHaveLength(0);
  });

  it("lets a shared network's unauthenticated noise pass without locking out a signed-in Spade there", async () => {
    const w = world();
    // Well under the coarse limit taken before authentication, far over the account's burst.
    const noise = Math.min(100, wranglerLimit("SEARCH_ADDRESS_REQUESTS") - 5);
    expect(noise).toBeGreaterThan(wranglerLimit("SEARCH_ACCOUNT_BURST") * 3);
    for (let i = 0; i < noise; i++)
      expect((await w.search(fresh(), { token: "x".repeat(43) })).status).toBe(401);
    expect((await w.search(fresh())).status).toBe(200);
  });
});

describe("Ceramic and what it costs", () => {
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

  it("keeps the reservation once the paid call went out, whatever came back", async () => {
    const w = world({ limits: { globalDaily: 5 } });
    const billed: Answer[] = [
      () => ok({ items: [{ url: "https://a.example/", title: "x".repeat(300_000) }] }),
      () => new Response("not json"),
      () => new Response("upstream", { status: 500 }),
      () => {
        throw new Error("binding down");
      },
    ];
    for (const answer of billed) {
      w.answerWith(answer);
      const response = await w.search(fresh());
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "search_failed" });
    }
    expect(await used(await w.usage())).toBe(4);
    // The breaker counted them too: one search is left today, then ace search rests.
    w.answerWith(() => ok({ items: items(1) }));
    expect((await w.search(fresh())).status).toBe(200);
    expect((await refusal(await w.search(fresh()))).error).toBe("resting");
    expect(w.asked.map((asked) => asked.provider)).toEqual(Array(5).fill("ceramic"));
  });

  it("gives the reservation back only when the gateway turned the call away before sending it", async () => {
    const w = world();
    for (const status of [401, 403, 404]) {
      w.answerWith(() => Response.json({ success: false }, { status }));
      expect((await w.search(fresh())).status).toBe(502);
    }
    expect(await used(await w.usage())).toBe(0);
  });

  it("bounds the answer: ten results at most, fields cut, odd items dropped", async () => {
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

describe("the gateway", () => {
  it("sends nothing to Ceramic and counts nothing while the gateway may keep queries", async () => {
    const w = world({ gatewaySafe: async () => false });
    const response = await w.search(fresh());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "search_unavailable" });
    expect(w.asked).toHaveLength(0);
    expect(w.counts()).toBe("[]");
  });

  it("answers search_unavailable until the AI binding and gateway are configured", async () => {
    const w = world({ ai: false });
    expect((await w.search(fresh())).status).toBe(503);
  });
});

describe("privacy", () => {
  it("never stores or logs the query text or the caller's address, only counts", async () => {
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
    const stored: string[] = [];
    const tables = w.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables)
      stored.push(JSON.stringify(w.sqlite.prepare(`SELECT * FROM "${name}"`).all()));
    const everything = [...stored, ...w.logs, ...lines].join("\n");
    expect(everything).not.toContain("patient-4417");
    expect(everything).not.toContain("lab results");
    expect(everything).not.toContain("203.0.113.7");
    expect(w.logs.length).toBeGreaterThan(0);
  });
});
