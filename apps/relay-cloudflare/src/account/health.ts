import type { AccountConfig } from "./config.ts";

/**
 * Whether WorkOS accepts the Worker's own credentials, as `GET /v1/account/health` reports it.
 * Only verdicts leave the Worker, never the key, its length or any part of it.
 */
export interface WorkosHealth {
  /** WorkOS accepted the API key (`refused`: 401/403; `unreachable`: anything else). */
  apiKey: "accepted" | "refused" | "unreachable";
  /** The key reads as one `sk_…` value, with nothing pasted around it. */
  keyFormat: "ok" | "unexpected";
  /** WorkOS knows the client id (it publishes keys for it). */
  clientId: "known" | "unknown" | "unreachable";
}

/** How long one answer is reused, so the route can't be used to hammer WorkOS. */
export const HEALTH_REUSE_MS = 30_000;

const keyShape = /^sk_\S+$/;

async function status(fetcher: typeof fetch, url: string, init: RequestInit) {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}

/** Checks the credentials against WorkOS, reusing an answer for `HEALTH_REUSE_MS`. */
export function workosHealth(config: AccountConfig, fetcher: typeof fetch, now: () => number) {
  let last: { at: number; health: WorkosHealth } | undefined;
  return async function check(): Promise<WorkosHealth> {
    if (last && now() - last.at < HEALTH_REUSE_MS) return last.health;
    const base = config.workosUrl;
    const [keyStatus, clientStatus] = await Promise.all([
      status(fetcher, `${base}/user_management/users?limit=1`, {
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
      }),
      status(fetcher, `${base}/sso/jwks/${encodeURIComponent(config.clientId)}`, {
        headers: { Accept: "application/json" },
      }),
    ]);
    const health: WorkosHealth = {
      apiKey:
        keyStatus === 200
          ? "accepted"
          : keyStatus === 401 || keyStatus === 403
            ? "refused"
            : "unreachable",
      keyFormat: keyShape.test(config.apiKey) ? "ok" : "unexpected",
      clientId:
        clientStatus === 200
          ? "known"
          : clientStatus === 404 || clientStatus === 400
            ? "unknown"
            : "unreachable",
    };
    last = { at: now(), health };
    return health;
  };
}
