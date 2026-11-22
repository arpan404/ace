import { expect, it } from "vitest";
import { gatewayCheck } from "./gateway.ts";

/*
 * Whether ace search's AI Gateway keeps nothing (ADR 0210 §4), read from a fake of Cloudflare's
 * API: search runs only with logs, Logpush and caching off, or on the owner's word when the
 * settings can't be read.
 */

const API = { accountId: "acct123", token: "cf-token-secret" };
const settings = (result: Record<string, unknown>) =>
  Response.json({ success: true, result: { id: "ace-search", ...result } });
const keepsNothing = { collect_logs: false, cache_ttl: 0, logpush: false };

function check(options: {
  answer?: () => Response | Promise<Response>;
  api?: typeof API | undefined;
  verifiedByHand?: boolean;
}) {
  let clock = 0;
  const asked: { url: string; auth: string | null }[] = [];
  const logs: string[] = [];
  const gateway = gatewayCheck({
    gatewayId: "ace-search",
    api: "api" in options ? options.api : API,
    verifiedByHand: options.verifiedByHand ?? false,
    fetch: async (input, init) => {
      asked.push({
        url: String(input),
        auth: new Headers(init?.headers).get("Authorization"),
      });
      return (options.answer ?? (() => settings(keepsNothing)))();
    },
    now: () => clock,
    log: (outcome) => logs.push(outcome),
  });
  return { gateway, asked, logs, advance: (ms: number) => (clock += ms) };
}

it("searches through a gateway that keeps no logs, pushes none and caches nothing", async () => {
  const c = check({});
  expect(await c.gateway.safe()).toBe(true);
  expect(c.asked[0]).toEqual({
    url: "https://api.cloudflare.com/client/v4/accounts/acct123/ai-gateway/gateways/ace-search",
    auth: "Bearer cf-token-secret",
  });
});

it("refuses a gateway that collects logs, pushes them or caches, even with the owner's word", async () => {
  for (const kept of [{ collect_logs: true }, { logpush: true }, { cache_ttl: 300 }]) {
    const c = check({ answer: () => settings({ ...keepsNothing, ...kept }), verifiedByHand: true });
    expect(await c.gateway.safe()).toBe(false);
    expect(c.logs).toEqual(["gateway_keeps_logs"]);
  }
});

it("can't read the settings: refuses, unless the owner said they checked by hand", async () => {
  const unreadable = [
    () => new Response("forbidden", { status: 403 }),
    () => Response.json({ success: true, result: { id: "ace-search" } }),
    () => {
      throw new Error("network");
    },
  ];
  for (const answer of unreadable) {
    expect(await check({ answer }).gateway.safe()).toBe(false);
    expect(await check({ answer, verifiedByHand: true }).gateway.safe()).toBe(true);
  }
  expect(await check({ api: undefined }).gateway.safe()).toBe(false);
  expect(await check({ api: undefined, verifiedByHand: true }).gateway.safe()).toBe(true);
});

it("notices logging turned on within minutes, and the token never reaches a log", async () => {
  let logging = false;
  const c = check({ answer: () => settings({ ...keepsNothing, collect_logs: logging }) });
  expect(await c.gateway.safe()).toBe(true);
  logging = true;
  c.advance(60_000);
  expect(await c.gateway.safe()).toBe(true);
  c.advance(5 * 60_000);
  expect(await c.gateway.safe()).toBe(false);
  expect(c.logs.join(" ")).not.toContain("cf-token-secret");
});

it("concurrent checks share one reading, so an older answer can't land after a newer one", async () => {
  let reads = 0;
  const c = check({
    answer: async () => {
      reads++;
      // The first reading is slow and safe; any second one would be quick and refuse.
      if (reads === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return settings(keepsNothing);
      }
      return settings({ ...keepsNothing, collect_logs: true });
    },
  });
  const answers = await Promise.all(Array.from({ length: 10 }, () => c.gateway.safe()));
  expect(new Set(answers)).toEqual(new Set([true]));
  expect(c.asked).toHaveLength(1);
});

it("once seen keeping logs, stays refused while the settings can't be read, whatever the owner said", async () => {
  let answer: () => Response = () => settings({ ...keepsNothing, collect_logs: true });
  const c = check({ answer: () => answer(), verifiedByHand: true });
  expect(await c.gateway.safe()).toBe(false);
  answer = () => new Response("unavailable", { status: 503 });
  c.advance(2 * 60_000);
  expect(await c.gateway.safe()).toBe(false);
  answer = () => settings(keepsNothing);
  c.advance(2 * 60_000);
  expect(await c.gateway.safe()).toBe(true);
});
