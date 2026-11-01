import { expect, test } from "vitest";
import { join } from "node:path";
import { PriceRefresh } from "./price-refresh.ts";
import { defaultPrices, UsageSettings } from "./settings.ts";
import { setup, query } from "./test-support.ts";

const hour = 3_600_000;
const body = { "future-model": { input_cost_per_token: 2e-6, output_cost_per_token: 4e-6 } };
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
test("an unknown usage model triggers one refresh then existing usage is priced", async () => {
  const f = fixture();
  const refresh = f.create();
  await refresh.load();
  expect(f.h.totals().unpricedTokens).toBe(1e6);
  await Promise.all([refresh.refresh(f.h.store.hasUnpricedModels()), refresh.refresh(true)]);
  expect(f.requests).toBe(1);
  expect(f.h.totals({ ...query, equivalentApiCost: true }).equivalentApiUsd).toBe(2);
  expect(f.h.totals().unpricedTokens).toBe(0);
});
test("daily requests use conditional headers and the daily limit survives restart", async () => {
  const f = fixture();
  let refresh = f.create();
  await refresh.load();
  await refresh.refresh();
  refresh = f.create();
  await refresh.load();
  f.advance(24 * hour - 1);
  await refresh.refresh();
  expect(f.requests).toBe(1);
  f.advance(1);
  f.reply(() => new Response(null, { status: 304 }));
  await refresh.refresh();
  expect(f.requests).toBe(2);
  expect(f.headers[1]?.get("If-None-Match")).toBe('"v1"');
  expect(f.h.totals().unpricedTokens).toBe(0);
});
test("unknown-model bursts get at most one additional request per hour across restart", async () => {
  const f = fixture();
  let refresh = f.create();
  await refresh.load();
  await refresh.refresh();
  for (let i = 0; i < 20; i++) await refresh.refresh(true);
  expect(f.requests).toBe(1);
  f.advance(hour);
  await refresh.refresh(true);
  expect(f.requests).toBe(2);
  refresh = f.create();
  await refresh.load();
  await refresh.refresh(true);
  expect(f.requests).toBe(2);
});
test("bad downloads preserve disk prices and failures back off", async () => {
  const f = fixture();
  const refresh = f.create();
  await refresh.load();
  await refresh.refresh();
  f.advance(hour);
  f.reply(() => new Response('{"error": "bad"}'));
  await refresh.refresh(true);
  expect(f.requests).toBe(2);
  expect(f.h.totals().unpricedTokens).toBe(0);
  const restarted = f.create();
  await restarted.load();
  await restarted.refresh(true);
  expect(f.requests).toBe(2);
  expect(f.h.totals({ ...query, equivalentApiCost: true }).equivalentApiUsd).toBe(2);
});
test("offline starts with bundled prices and disabling fetching ignores the disk list", async () => {
  const f = fixture();
  const refresh = f.create();
  await refresh.load();
  f.reply(() => {
    throw new Error("offline");
  });
  await refresh.refresh();
  f.h.agent("priced", null, "claude-sonnet-4-6");
  f.h.usage(1e6, "priced");
  expect(f.h.totals().apiInputUsd).toBe(3);
  const disabled = f.create(false);
  await disabled.load();
  await disabled.refresh(true);
  expect(f.requests).toBe(1);
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
  await online.refresh();
  f.h.store.updatePrices(defaultPrices);
  expect(f.h.totals().unpricedTokens).toBe(0); // The online store retains its observed historical rate.
  f.h.reopen({ fetchPrices: false });
  const offline = f.create(false);
  await offline.load();
  await offline.refresh(true);
  expect(f.requests).toBe(1);
  expect(f.h.totals().unpricedTokens).toBe(1e6);
});
