import { z } from "zod";

/**
 * Whether ace search's AI Gateway keeps nothing (ADR 0210 §4): log collection off, Logpush off
 * and caching off. Web Search requests are logged by the gateway like any other when collection
 * is on, which would keep raw queries, so the route searches only once this holds.
 *
 * With an API token (AI Gateway Read) and the account id configured, the gateway's settings are
 * read from Cloudflare's API on first use and again every few minutes. A gateway that keeps
 * logs, pushes them or caches is refused whatever else says so. When the settings can't be read
 * (no token, or the API failed), search runs only if the owner set `ACE_SEARCH_GATEWAY_VERIFIED`
 * to say they checked it by hand.
 */

/** The exact value of `ACE_SEARCH_GATEWAY_VERIFIED` that says the owner checked by hand. */
export const VERIFIED_BY_HAND = "logs-off-cache-off";
/** How long a reading is trusted: a good one, and one that refused. */
const GOOD_FOR_MS = 5 * 60_000;
const REFUSED_FOR_MS = 60_000;

const Gateway = z.object({
  success: z.literal(true),
  result: z.object({
    collect_logs: z.boolean(),
    cache_ttl: z.number().nullable(),
    logpush: z.boolean().nullish(),
  }),
});

/** Why the gateway was refused, as a log outcome: never the token or the account. */
export type GatewayOutcome = "gateway_keeps_logs" | "gateway_unchecked";

export function gatewayCheck(deps: {
  gatewayId: string;
  /** The Cloudflare account id and an AI Gateway Read token; both, or no reading. */
  api: { accountId: string; token: string } | undefined;
  verifiedByHand: boolean;
  fetch: typeof fetch;
  now: () => number;
  log: (outcome: GatewayOutcome) => void;
}) {
  let reading: { safe: boolean; until: number } | undefined;
  let inflight: Promise<boolean> | undefined;
  let keepsLogs = false;

  /** The gateway's settings: true when it keeps nothing, false when it keeps something. */
  async function read(api: { accountId: string; token: string }): Promise<boolean | undefined> {
    try {
      const response = await deps.fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(api.accountId)}/ai-gateway/gateways/${encodeURIComponent(deps.gatewayId)}`,
        { headers: { Authorization: `Bearer ${api.token}` }, redirect: "manual" },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return undefined;
      }
      const parsed = Gateway.safeParse(await response.json());
      if (!parsed.success) return undefined;
      const { collect_logs, cache_ttl, logpush } = parsed.data.result;
      return !collect_logs && (cache_ttl ?? 0) === 0 && logpush !== true;
    } catch {
      return undefined;
    }
  }

  /**
   * One reading at a time: every caller waiting meanwhile shares it, so an answer that started
   * earlier can never land after, and replace, a later one.
   */
  async function refresh(now: number): Promise<boolean> {
    const settings = deps.api ? await read(deps.api) : undefined;
    // Seen keeping logs, the gateway stays refused until a reading shows it keeps nothing: a
    // reading that fails says nothing new, and the owner's word can't outweigh what was seen.
    if (settings !== undefined) keepsLogs = !settings;
    let safe: boolean;
    if (keepsLogs) {
      deps.log("gateway_keeps_logs");
      safe = false;
    } else if (settings === true) {
      safe = true;
    } else {
      safe = deps.verifiedByHand;
      if (!safe) deps.log("gateway_unchecked");
    }
    reading = { safe, until: now + (safe ? GOOD_FOR_MS : REFUSED_FOR_MS) };
    return safe;
  }

  return {
    /** Whether ace search may send queries through the gateway now. */
    async safe(): Promise<boolean> {
      const now = deps.now();
      if (reading && now < reading.until) return reading.safe;
      inflight ??= refresh(now).finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
export type GatewayCheck = ReturnType<typeof gatewayCheck>;
