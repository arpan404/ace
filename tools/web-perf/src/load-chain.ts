/**
 * The request chain of a page load, from what DevTools reports for each request: which document
 * or script asked for it. A request's round trip is one more than that of the response that
 * named it, so the deepest request before first content is the number of sequential round
 * trips the first screen waited on (the page itself is round trip 1). A request DevTools can't
 * attribute (a preload link a script added, reported from `about:client`) is taken to come
 * from the request that finished last before it started: the script that was running.
 */
export interface LoadRequest {
  url: string;
  /** The response that named this request: null for the navigation, undefined if unknown. */
  initiator: string | null | undefined;
  /** When the request started and finished, ms from navigation. */
  startMs: number;
  endMs: number;
  /** Bytes on the wire, headers included. */
  bytes: number;
}

export interface LoadChain {
  /** Requests that started before `untilMs`. */
  requests: number;
  bytes: number;
  /** Sequential round trips on the deepest chain before `untilMs`. */
  roundTrips: number;
  /** That chain, page first. */
  path: string[];
}

export function loadChain(requests: readonly LoadRequest[], untilMs: number): LoadChain {
  const before = requests.filter((request) => request.startMs <= untilMs);
  const byUrl = new Map(before.map((request) => [request.url, request]));
  const parents = new Map<LoadRequest, LoadRequest | undefined>();
  for (const request of before) {
    if (request.initiator === null) continue;
    const named = request.initiator === undefined ? undefined : byUrl.get(request.initiator);
    let latest: LoadRequest | undefined;
    if (!named)
      for (const other of before)
        if (
          other !== request &&
          other.endMs <= request.startMs &&
          (!latest || other.endMs > latest.endMs)
        )
          latest = other;
    parents.set(request, named ?? latest);
  }
  const depths = new Map<string, number>();
  const depth = (request: LoadRequest, seen: Set<string>): number => {
    const known = depths.get(request.url);
    if (known !== undefined) return known;
    const parent = parents.get(request);
    // A request named by itself, or in a loop, starts its own chain.
    const value =
      parent && parent !== request && !seen.has(parent.url)
        ? depth(parent, new Set([...seen, request.url])) + 1
        : 1;
    depths.set(request.url, value);
    return value;
  };
  let deepest: LoadRequest | undefined;
  for (const request of before)
    if (!deepest || depth(request, new Set()) > depth(deepest, new Set())) deepest = request;
  const path: string[] = [];
  for (let at = deepest; at;) {
    path.unshift(at.url);
    const parent = parents.get(at);
    at = parent && !path.includes(parent.url) ? parent : undefined;
  }
  return {
    requests: before.length,
    bytes: before.reduce((total, request) => total + request.bytes, 0),
    roundTrips: deepest ? depth(deepest, new Set()) : 0,
    path,
  };
}
