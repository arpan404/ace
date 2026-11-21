import { AceOrgStanding } from "@ace/protocol/ace-org";

/**
 * Asks the account backend whether an org grant still speaks for its member (ADR 0206 §6):
 * `POST /v1/grants/standing`, the grant as its own proof. Undefined for no address configured,
 * an unreachable backend or an answer that isn't one: the caller refuses.
 */
export async function askOrgStanding(
  url: string | undefined,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  grant: string,
): Promise<{ current: boolean } | undefined> {
  if (!url) return undefined;
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const answer = AceOrgStanding.safeParse(await response.json());
    return answer.success ? { current: answer.data.current } : undefined;
  } catch {
    return undefined;
  }
}
