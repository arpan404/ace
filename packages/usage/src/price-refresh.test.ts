import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { PRICE_MAX_AGE_MS, PriceRefresh } from "./price-refresh.ts";
import { defaultPrices, UsageSettings } from "./settings.ts";
import { setup, query } from "./test-support.ts";

const hour = 3_600_000;
const body = {
  "future-model": { input_cost_per_token: 2e-6, output_cost_per_token: 4e-6 },
  "another-model": { input_cost_per_token: 3e-6, output_cost_per_token: 5e-6 },
  "unused-model": { input_cost_per_token: 8e-6, output_cost_per_token: 9e-6 },
};
const goodReply = () => new Response(JSON.stringify(body), { headers: { etag: '"v1"' } });
const rate = (input: number, asOf: string) => ({
  version: asOf,
  asOf,
  sources: [],
  models: {
    "future-model": { input, output: 0, cached: input, write: input, write1h: input },
  },
});
function fixture() {
  const h = setup();
  h.thread();
  h.agent("root", null, "future-model");
  h.usage(1e6);
  let time = Date.parse("2026-11-01T00:00Z");
  let requests = 0;
  let reply = goodReply;
  const headers: Headers[] = [];
  const network: typeof fetch = async (_url, init) => {
    requests++;
    headers.push(new Headers(init?.headers));
    return reply();
  };
  const create = (enabled = true) =>
    new PriceRefresh(
      join(h.home, "prices.json"),
      UsageSettings.parse({ fetchPrices: enabled }),
      () => time,
      network,
      (p) => h.store.updatePrices(p),
      () => {},
    );
  return {
    h,
    create,
    headers,
    get requests() {
      return requests;
    },
    advance(ms: number) {
      time += ms;
    },
    reply(fn: () => Response) {
      reply = fn;
    },
  };
}
test("a new usage model fetches once and caches only that model from the full catalogue", async () => {
  const f = fixture();
  const refresh = f.create();
  await refresh.load();
  expect(f.requests).toBe(0);
  expect(f.h.totals().unpricedTokens).toBe(1e6);
  await Promise.all([refresh.refresh(f.h.store.modelsInUse()), refresh.refresh(["future-model"])]);
  const cache = JSON.parse(await readFile(join(f.h.home, "prices.json"), "utf8"));
  expect(Object.keys(cache.models)).toEqual(["future-model"]);
  expect(cache.models["future-model"].fetchedAt).toBe(Date.parse("2026-11-01T00:00Z"));
  expect(f.requests).toBe(1);
  expect(f.h.totals({ ...query, equivalentApiCost: true }).equivalentApiUsd).toBe(2);
});
test("a price under three days old avoids fetching even after worker restart", async () => {
  const f = fixture();
  let refresh = f.create();
  await refresh.load();
  await refresh.refresh(f.h.store.modelsInUse());
  f.advance(PRICE_MAX_AGE_MS - 1);
  refresh = f.create();
  await refresh.load();
  await refresh.refresh(f.h.store.modelsInUse());
  expect(f.requests).toBe(1);
  await refresh.refresh([]);
  expect(f.requests).toBe(1);
});
test("three-day expiry revalidates prices conditionally and renews each fetched-at time", async () => {
  const f = fixture();
  const refresh = f.create();
  await refresh.load();
  await refresh.refresh(f.h.store.modelsInUse());
  f.advance(PRICE_MAX_AGE_MS);
  f.reply(() => new Response(null, { status: 304 }));
  await refresh.refresh(f.h.store.modelsInUse());
  expect(f.requests).toBe(2);
  expect(f.headers[1]?.get("If-None-Match")).toBe('"v1"');
  await refresh.refresh(f.h.store.modelsInUse());
  expect(f.requests).toBe(2);
  const cache = JSON.parse(await readFile(join(f.h.home, "prices.json"), "utf8"));
  expect(cache.models["future-model"].fetchedAt).toBe(
    Date.parse("2026-11-01T00:00Z") + PRICE_MAX_AGE_MS,
  );
});
test("a second used model waits for the hourly allowance then adds only its price", async () => {
  const f = fixture();
  let refresh = f.create();
  await refresh.load();
  await refresh.refresh(f.h.store.modelsInUse());
  const before = JSON.parse(await readFile(join(f.h.home, "prices.json"), "utf8"));
  f.h.agent("second", null, "another-model");
  f.h.usage(1e6, "second");
  for (let i = 0; i < 20; i++) await refresh.refresh(f.h.store.modelsInUse());
  expect(f.requests).toBe(1);
  refresh = f.create();
  await refresh.load();
  await refresh.refresh(f.h.store.modelsInUse());
  expect(f.requests).toBe(1);
  f.advance(hour);
  await refresh.refresh(f.h.store.modelsInUse());
  expect(f.requests).toBe(2);
  expect(f.headers[1]?.has("If-None-Match")).toBe(false);
  const cache = JSON.parse(await readFile(join(f.h.home, "prices.json"), "utf8"));
  expect(Object.keys(cache.models).toSorted()).toEqual(["another-model", "future-model"]);
  expect(cache.models["future-model"]).toEqual(before.models["future-model"]);
  expect(f.h.totals().unpricedTokens).toBe(0);
});
test("per-model validators and ages remain independent when a newer model is added", async () => {
  const f = fixture();
  const refresh = f.create();
  await refresh.load();
  await refresh.refresh(f.h.store.modelsInUse());
  f.advance(hour);
  f.h.agent("second", null, "another-model");
  f.h.usage(1e6, "second");
  f.reply(() => new Response(JSON.stringify(body), { headers: { etag: '"v2"' } }));
  await refresh.refresh(f.h.store.modelsInUse());
  const before = JSON.parse(await readFile(join(f.h.home, "prices.json"), "utf8"));
  f.advance(PRICE_MAX_AGE_MS - hour);
  f.reply(() => new Response(null, { status: 304 }));
  await refresh.refresh(f.h.store.modelsInUse());
  expect(f.headers[2]?.get("If-None-Match")).toBe('"v1"');
  const after = JSON.parse(await readFile(join(f.h.home, "prices.json"), "utf8"));
  expect(after.models["another-model"]).toEqual(before.models["another-model"]);
  expect(after.models["future-model"].fetchedAt).toBeGreaterThan(
    before.models["future-model"].fetchedAt,
  );
});
test.each(["bad", "partial", "offline"])(
  "an expired price survives a %s download and cache bytes stay unchanged",
  async (kind) => {
    const f = fixture();
    const refresh = f.create();
    await refresh.load();
    await refresh.refresh(f.h.store.modelsInUse());
    const before = await readFile(join(f.h.home, "prices.json"));
    f.advance(PRICE_MAX_AGE_MS + 1);
    f.reply(() => {
      if (kind === "offline") throw new Error("offline");
      return new Response(kind === "bad" ? '{"error":"bad"}' : '{"future-model":');
    });
    await refresh.refresh(f.h.store.modelsInUse());
    expect(f.requests).toBe(2);
    expect(await readFile(join(f.h.home, "prices.json"))).toEqual(before);
    expect(f.h.totals({ ...query, equivalentApiCost: true }).equivalentApiUsd).toBe(2);
    const restarted = f.create();
    await restarted.load();
    await restarted.refresh(f.h.store.modelsInUse());
    expect(f.requests).toBe(2);
    expect(await readFile(join(f.h.home, "prices.json"))).toEqual(before);
  },
);
test("offline uses bundled prices without creating a price cache", async () => {
  const f = fixture();
  const refresh = f.create();
  await refresh.load();
  f.reply(() => {
    throw new Error("offline");
  });
  await refresh.refresh(f.h.store.modelsInUse());
  f.h.agent("priced", null, "claude-sonnet-4-6");
  f.h.usage(1e6, "priced");
  expect(f.h.totals().apiInputUsd).toBe(3);
  await expect(readFile(join(f.h.home, "prices.json"))).rejects.toThrow();
});
test("daily estimates retain observed price dates and new prices cover older unpriced days", () => {
  const h = setup();
  h.thread();
  h.agent("root", null, "future-model");
  h.usage(1e6, "root", { counterMode: "incremental" }, Date.parse("2026-10-20T12:00Z"));
  h.store.updatePrices(rate(2, "2026-10-21"));
  h.store.updatePrices(rate(4, "2026-10-25"));
  h.usage(1e6, "root", { counterMode: "incremental" }, Date.parse("2026-10-26T12:00Z"));
  expect(h.totals().apiInputUsd).toBe(6);
  expect(h.store.series(query).rows.map((r) => r.totals.apiInputUsd)).toEqual([2, 4]);
});

test("offline-only mode ignores a successfully downloaded list", async () => {
  const f = fixture();
  const online = f.create();
  await online.load();
  await online.refresh(f.h.store.modelsInUse());
  f.h.store.updatePrices(defaultPrices);
  expect(f.h.totals().unpricedTokens).toBe(0); // The online store retains its observed historical rate.
  f.h.reopen({ fetchPrices: false });
  const offline = f.create(false);
  await offline.load();
  await offline.refresh(f.h.store.modelsInUse());
  expect(f.requests).toBe(1);
  expect(f.h.totals().unpricedTokens).toBe(1e6);
});
