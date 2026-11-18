import {
  ACE_CLIENT_HEADER,
  ACE_CLIENT_PARAM,
  AceClient,
  type AceClientApp,
} from "@ace/protocol/ace-client";

/*
 * How an ace app names itself to ace cloud and the market (ADR 0189): one place per runtime
 * builds the name, and these helpers put it on every request to them.
 */

/**
 * The `ace-client` value for `app` at `version` (its semver, or `development` for a build that
 * isn't a release). Undefined when the version is missing or isn't one of those: the app then
 * sends nothing and is served as an unknown client, never misnamed.
 */
export function aceClientName(
  app: AceClientApp,
  version: string | undefined,
): AceClient | undefined {
  if (!version) return undefined;
  const name = AceClient.safeParse(`${app}/${version}`);
  return name.success ? name.data : undefined;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` that names the app on every request it makes. Give it only to code that calls ace
 * cloud or the market. Without a name it is `fetch` itself.
 */
export function namedFetch<F extends Fetch>(fetch: F, name: AceClient | undefined): F | Fetch {
  if (!name) return fetch;
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(ACE_CLIENT_HEADER, name);
    return fetch(input, { ...init, headers });
  };
}

/** A browser WebSocket upgrade's URL, which can't carry headers, naming the app instead. */
export function namedUpgradeUrl(url: URL, name: AceClient | undefined): URL {
  if (name) url.searchParams.set(ACE_CLIENT_PARAM, name);
  return url;
}
