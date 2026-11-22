import { z } from "zod";
import { verifyCloudGrant } from "@ace/account-grant";
import type { GrantKeySet } from "@ace/account-grant";
import { fail, json, jsonBody } from "../account/respond.ts";
import { CeramicFailed, MOST_RESULTS, searchCeramic } from "./ceramic.ts";
import type { WebSearchBinding } from "./ceramic.ts";
import type { SearchCounters } from "./counters.ts";
import type { GatewayCheck } from "./gateway.ts";
import { REASONS, countersFor, dayOf, isNewAccount, monthOf, secondsUntil } from "./limits.ts";
import type { Counter, Refusal, SearchLimits, Searcher } from "./limits.ts";
import type { RepeatGuard } from "./repeats.ts";

/**
 * ace search (ADR 0210): `POST /v1/search` and `GET /v1/search/usage`, for Spade's `web_search`
 * only (§3). A Spade shows its cloud credential (the `spade-cloud` grant), which counts only
 * while the machine it names holds a live machine credential on the account, read on every
 * call. Anything else is refused: a bare session or machine credential, a grant for a machine
 * the account doesn't hold, anything carrying an Origin. Every limit is the Worker's (§4).
 * Query text is never stored or logged: the log lines below carry an outcome code only.
 */

export const MOST_QUERY = 400;
const MOST_BODY_BYTES = 4 * 1024;
const BURST_SECONDS = 60;

const SearchRequest = z.object({
  query: z.string().trim().min(1).max(MOST_QUERY),
  limit: z.number().int().min(1).max(MOST_RESULTS).optional(),
  freshness: z.enum(["day", "week", "month", "year"]).optional(),
});

/** What a search log line may say: an outcome code, never a query, account or token. */
export type SearchLog = { search: string };

export type SearchDeps = {
  keys: GrantKeySet;
  counters: SearchCounters;
  /** Workers AI with the gateway it bills; undefined until both are configured. */
  ai: { binding: WebSearchBinding; gatewayId: string } | undefined;
  /** Whether the gateway keeps nothing (logs, Logpush, cache): no query is sent until it does. */
  gateway: Pick<GatewayCheck, "safe">;
  /** `ACE_SEARCH_ENABLED`: false is the kill switch, turned before the gateway's settings change. */
  enabled: boolean;
  limits: SearchLimits;
  repeats: RepeatGuard;
  now: () => number;
  /** The caller's address as a counter key (an IPv6 /64 or an IPv4 address). */
  addressOf: (request: Request) => string;
  /** Salts the address's digest, so no counter row holds an address. */
  addressSalt: string;
  /**
   * The per-minute limits, from rate-limit bindings: true when over. `address` is coarse and
   * taken before authentication; `account` is the tight burst, taken after it.
   */
  burst: { address(key: string): Promise<boolean>; account(id: string): Promise<boolean> };
  log: (entry: SearchLog) => void;
};

/** The caller's address as its counter knows it: a salted SHA-256, never the address. */
async function addressDigest(salt: string, address: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}\n${address}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function refuse(code: Refusal, retryAfter: number): Response {
  const response = json(429, { error: code, reason: REASONS[code], retryAfter });
  response.headers.set("Retry-After", String(retryAfter));
  return response;
}

export function searchRoutes(deps: SearchDeps) {
  const { now, counters, limits } = deps;

  /**
   * Who is asking: a Spade's cloud credential for a live machine of its account, or the refusal.
   * The machine is the grant's subject, so its caps are that machine's; a grant for a host id
   * the account holds no live credential for (as a browser session can mint) opens nothing.
   */
  async function searcher(request: Request): Promise<Searcher | Response> {
    const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token) return fail(401, "unauthenticated");
    let claims: { account: string; subject: string };
    try {
      claims = verifyCloudGrant(token, deps.keys, now());
    } catch {
      return fail(401, "unauthenticated");
    }
    if (!(await counters.machineLive(claims.account, claims.subject, now())))
      return fail(403, "machine_unknown");
    const address = await addressDigest(deps.addressSalt, deps.addressOf(request));
    return { account: claims.account, machine: claims.subject, address };
  }

  /**
   * The checks every call passes first: no browser, configured, under the coarse address limit
   * (before authentication, so it is loose), a live Spade.
   */
  async function admit(request: Request): Promise<Searcher | Response> {
    if (request.headers.has("Origin")) return fail(403, "spade_only");
    if (!deps.enabled || !deps.ai) return fail(503, "search_unavailable");
    if (await deps.burst.address(deps.addressOf(request)))
      return refuse("search_busy", BURST_SECONDS);
    return searcher(request);
  }

  async function allowanceOf(account: string, at: number): Promise<number> {
    const young = isNewAccount(await counters.firstSeen(account), at, limits.newAccountDays);
    return young ? Math.min(limits.newAccountMonthly, limits.monthly) : limits.monthly;
  }

  const usage = (used: { month: number; day: number }, allowance: number, at: number) => ({
    month: { used: used.month, allowance },
    day: { used: used.day, cap: limits.daily },
    resetsAt: new Date(monthOf(at).ends).toISOString(),
  });

  return {
    async search(request: Request): Promise<Response> {
      const who = await admit(request);
      if (who instanceof Response) return who;
      if (await deps.burst.account(who.account)) return refuse("search_busy", BURST_SECONDS);
      const parsed = SearchRequest.safeParse(await jsonBody(request, MOST_BODY_BYTES));
      if (!parsed.success) return fail(400, "invalid_request");
      const { query, freshness } = parsed.data;
      const limit = parsed.data.limit ?? MOST_RESULTS;
      if (await deps.repeats.repeated(who.account, query))
        return refuse("repeated_query", BURST_SECONDS);
      // No query goes to a gateway that may keep it.
      if (!(await deps.gateway.safe())) return fail(503, "search_unavailable");
      const at = now();
      const young = isNewAccount(await counters.firstSeen(who.account), at, limits.newAccountDays);
      const taking: Counter[] = countersFor(who, limits, at, young);
      // The machine is checked again inside the reservation: a sign-out since authentication
      // stops the search here, before anything is sent.
      const taken = await counters.take(taking, {
        account: who.account,
        machine: who.machine,
        now: at,
      });
      if (!taken.taken && taken.machineGone) return fail(403, "machine_unknown");
      if (!taken.taken) {
        const full = taken.full;
        deps.log({ search: full?.refusal ?? "search_busy" });
        return full
          ? refuse(full.refusal, secondsUntil(full.period.ends, at))
          : refuse("search_busy", BURST_SECONDS);
      }
      const ai = deps.ai;
      if (!ai) return fail(503, "search_unavailable");
      try {
        const results = await searchCeramic(ai.binding, ai.gatewayId, query, limit, freshness, at);
        const [, month = 0, day = 0] = taken.counts;
        const allowance = taking[1]?.cap ?? limits.monthly;
        return json(200, {
          results,
          provider: "ceramic",
          usage: usage({ month, day }, allowance, at),
        });
      } catch (error) {
        // Once the paid call went out the search counts, whatever came back. Only a call the
        // gateway turned away before sending it to Ceramic is given back.
        const failed = error instanceof CeramicFailed ? error : new CeramicFailed("failed");
        if (!failed.billed) await counters.giveBack(taking);
        deps.log({ search: failed.message });
        return fail(502, "search_failed");
      }
    },

    async usage(request: Request): Promise<Response> {
      const who = await admit(request);
      if (who instanceof Response) return who;
      const at = now();
      const allowance = await allowanceOf(who.account, at);
      const [month = 0, day = 0] = await counters.read([
        { scope: `account:${who.account}`, period: monthOf(at), cap: 0, refusal: "monthly_spent" },
        { scope: `account:${who.account}`, period: dayOf(at), cap: 0, refusal: "daily_spent" },
      ]);
      return json(200, usage({ month, day }, allowance, at));
    },
  };
}
export type SearchRoutes = ReturnType<typeof searchRoutes>;
