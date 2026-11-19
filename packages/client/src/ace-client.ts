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
 * `fetch` that names the app in the `ace-client` header of every request it makes. Outside
 * browsers only (the daemon, the CLI, the desktop app's main process): in a browser a custom
 * header makes a cross-origin call send a CORS preflight, which a cloud that doesn't allow the
 * header refuses. Give it only to code that calls ace cloud or the market.
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

/** `url` naming the app in its `ace-client` query parameter, as a browser names itself. */
export function namedUrl(url: URL, name: AceClient | undefined): URL {
  if (name) url.searchParams.set(ACE_CLIENT_PARAM, name);
  return url;
}

/**
 * `fetch` for browsers (the web app, the desktop app's renderer and their workers): names the
 * app in the `ace-client` query parameter of every request and adds no header, so a
 * cross-origin call needs no preflight it didn't need before. Give it only to code that calls
 * ace cloud or the market.
 */
export function namedQueryFetch<F extends Fetch>(fetch: F, name: AceClient | undefined): F | Fetch {
  if (!name) return fetch;
  return (input, init) => {
    if (input instanceof Request)
      return fetch(new Request(namedUrl(new URL(input.url), name), input), init);
    return fetch(namedUrl(new URL(String(input)), name), init);
  };
}
