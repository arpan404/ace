import { AceOrgRoster } from "@ace/protocol/ace-org";
import { BackendUnreachable } from "./member-work.ts";

/** How long a roster fetch may take before it counts as no answer. */
export const ROSTER_FETCH_MS = 15_000;

/**
 * Fetches this host's roster (ADR 0209 §7.2). Only transport failure is no answer
 * (`BackendUnreachable`, which earns the offline allowance): no TCP or TLS answer, or no
 * complete answer in time. Every HTTP answer is the backend's word and earns none, whatever it
 * is: a refusal, the origin's own contention (503 `busy`, `roster_epoch_unset`), a proxy's or the
 * edge's 5xx, a redirect (never followed). So someone on the path who drops the backend's replies
 * gets exactly the bounded outage behaviour an outage gets, by design; one who forges an answer
 * gets none.
 */
export async function fetchRoster(
  fetcher: typeof fetch,
  session: { origin: string; token: string },
  org: string,
  host: string,
  timeoutMs = ROSTER_FETCH_MS,
): Promise<AceOrgRoster> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetcher(
      `${session.origin}/v1/orgs/${encodeURIComponent(org)}/hosts/${encodeURIComponent(host)}/roster`,
      {
        headers: { Authorization: `Bearer ${session.token}` },
        signal,
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
      },
    );
    text = await response.text();
  } catch (error) {
    throw new BackendUnreachable(error instanceof Error ? error.message : String(error));
  }
  if (response.status !== 200)
    throw new Error(`The backend refused this host's roster (${response.status}).`);
  return AceOrgRoster.parse(JSON.parse(text));
}
