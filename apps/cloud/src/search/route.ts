import { z } from "zod";
import { verifyCloudGrant } from "@ace/account-grant";
import type { GrantKeySet } from "@ace/account-grant";
import type { PrincipalReader } from "../account/principal.ts";
import { fail, json, jsonBody } from "../account/respond.ts";
import { CeramicFailed, MOST_RESULTS, searchCeramic } from "./ceramic.ts";
import type { WebSearchBinding } from "./ceramic.ts";
import type { SearchCounters } from "./counters.ts";
import { REASONS, countersFor, dayOf, isNewAccount, monthOf, secondsUntil } from "./limits.ts";
import type { Counter, Refusal, SearchLimits, Searcher } from "./limits.ts";
import type { RepeatGuard } from "./repeats.ts";

/**
 * ace search (ADR 0210): `POST /v1/search` and `GET /v1/search/usage`, for Spade's `web_search`
 * only. A Spade shows its cloud credential (the `spade-cloud` grant) or a machine credential; a
 * browser session, anything carrying an Origin, and an organization's host credential are
 * refused. Every limit is the Worker's (§4). Query text is never stored or logged: the log
 * lines below carry an outcome code and nothing else.
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
  principals: Pick<PrincipalReader, "read">;
  counters: SearchCounters;
  /** Workers AI with the gateway it bills; undefined until both are configured. */
  ai: { binding: WebSearchBinding; gatewayId: string } | undefined;
  limits: SearchLimits;
  repeats: RepeatGuard;
  now: () => number;
  /** The caller's address as a counter key (an IPv6 /64 or an IPv4 address). */
  addressOf: (request: Request) => string;
  /** The per-minute bursts, from rate-limit bindings: true when over. */
  burst: { address(key: string): Promise<boolean>; account(id: string): Promise<boolean> };
  log: (entry: SearchLog) => void;
};

const opaque = /^[A-Za-z0-9_-]{43}$/;

function refuse(code: Refusal, retryAfter: number): Response {
  const response = json(429, { error: code, reason: REASONS[code], retryAfter });
  response.headers.set("Retry-After", String(retryAfter));
  return response;
}

export function searchRoutes(deps: SearchDeps) {
  const { now, counters, limits } = deps;

  /** Who is asking, as a Spade acting for an account, or the refusal. */
  async function searcher(request: Request): Promise<Searcher | Response> {
    const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token) return fail(401, "unauthenticated");
    const address = deps.addressOf(request);
    if (opaque.test(token)) {
      const principal = await deps.principals.read(token);
      if (!principal) return fail(401, "unauthenticated");
      // A browser's session, or an organization's host: not a person's Spade.
      if (principal.kind !== "machine" || principal.org !== undefined)
        return fail(403, "spade_only");
      return { account: principal.account.id, machine: principal.hostId, address };
    }
    try {
      const claims = verifyCloudGrant(token, deps.keys, now());
      return { account: claims.account, machine: claims.subject, address };
    } catch {
      return fail(401, "unauthenticated");
    }
  }

  /** The checks every call passes first: no browser, configured, under the address burst, signed in. */
  async function admit(request: Request): Promise<Searcher | Response> {
    if (request.headers.has("Origin")) return fail(403, "spade_only");
    if (!deps.ai) return fail(503, "search_unavailable");
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
      const at = now();
      const young = isNewAccount(await counters.firstSeen(who.account), at, limits.newAccountDays);
      const taking: Counter[] = countersFor(who, limits, at, young);
      const { full, counts } = await counters.take(taking);
      if (full) {
        deps.log({ search: full.refusal });
        return refuse(full.refusal, secondsUntil(full.period.ends, at));
      }
      const ai = deps.ai;
      if (!ai) return fail(503, "search_unavailable");
      try {
        const results = await searchCeramic(ai.binding, ai.gatewayId, query, limit, freshness, at);
        const [, month = 0, day = 0] = counts ?? [];
        const allowance = taking[1]?.cap ?? limits.monthly;
        return json(200, {
          results,
          provider: "ceramic",
          usage: usage({ month, day }, allowance, at),
        });
      } catch (error) {
        // A search that never ran costs nothing: its counts go back.
        await counters.giveBack(taking);
        deps.log({ search: error instanceof CeramicFailed ? error.message : "failed" });
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
