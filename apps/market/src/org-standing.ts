import { AceOrgStanding } from "@ace/protocol/ace-org";

/**
 * Asks the account backend whether an org grant still speaks for its member (ADR 0206 §6):
 * `POST /v1/grants/standing`, with the market's own token. Undefined for no address or token,
 * an unreachable backend or an answer that isn't one: the caller refuses.
 */
export async function askOrgStanding(
  route: { url: string | undefined; token: string | undefined },
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  grant: string,
): Promise<{ current: boolean } | undefined> {
  if (!route.url || !route.token) return undefined;
  try {
    const response = await fetcher(route.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${route.token}` },
      body: JSON.stringify({ grant }),
      // Trust stays with the configured address: a redirect is never followed, and its 3xx is
      // no answer (Workers' fetch has no `redirect: "error"`).
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const answer = AceOrgStanding.safeParse(await response.json());
    return answer.success ? { current: answer.data.current } : undefined;
  } catch {
    return undefined;
  }
}
