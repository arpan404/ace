import {
  entryKey,
  get,
  handle,
  hash,
  post,
  versionKey,
  type Matched,
  type Methods,
  type Route,
} from "./route-keys.ts";
import { meRoutes, signerRoutes } from "./routes-more.ts";

export type { EntryKey, Matched, Methods, Route, VersionKey } from "./route-keys.ts";

/*
 * Which route a request names (ADR 0168 §3, §7; ADR 0174 §11; the contracts are in
 * @ace/protocol/marketplace). Pure: a method and a path in, a route or a refusal out. A path
 * segment that isn't a valid type, name, version, hash, handle or id names nothing.
 */

/** The catalog's and Discover's paths: `/v1/<first>/…`. */
function publicPath(parts: readonly string[]): Methods | undefined {
  const [, first, a, b, c, ...rest] = parts;
  if (rest.length > 0) return undefined;
  const only = (count: number) => parts.length === count;
  switch (first) {
    case "index":
    case "search":
    case "categories":
    case "featured":
    case "withdrawn":
    case "blocklist":
    case "verified":
    case "official":
    case "discover":
      return only(2) ? get({ kind: first }) : undefined;
    case "reports":
      return only(2) ? post({ kind: "report" }) : undefined;
    case "entries": {
      if (only(4)) {
        const entry = entryKey(a, b);
        return entry ? get({ kind: "entry", ...entry }) : undefined;
      }
      const key = only(5) ? versionKey(a, b, c) : undefined;
      return key ? get({ kind: "version", ...key }) : undefined;
    }
    case "objects":
    case "avatars":
    case "previews": {
      const h = only(3) ? hash(a) : undefined;
      if (!h) return undefined;
      const kind = first === "objects" ? "object" : first === "avatars" ? "avatar" : "preview";
      return get({ kind, hash: h });
    }
    case "publishers": {
      const h = only(3) ? handle(a) : undefined;
      return h ? get({ kind: "publisher", handle: h }) : undefined;
    }
    default:
      return undefined;
  }
}

/** `/v1/publish/{type}/{name}/versions[/{version}/withdraw]`, the CLI's publishing. */
function publishPath(parts: readonly string[]): Methods | undefined {
  const [, , a, b, c, d, e] = parts;
  if (c !== "versions") return undefined;
  if (parts.length === 5) {
    const entry = entryKey(a, b);
    return entry ? post({ kind: "publish", ...entry }) : undefined;
  }
  const key = parts.length === 7 && e === "withdraw" ? versionKey(a, b, d) : undefined;
  return key ? post({ kind: "withdraw", ...key }) : undefined;
}

/** Every method `pathname` takes, with the route each names. */
export function routesFor(pathname: string): Methods | undefined {
  const parts = pathname.split("/").slice(1);
  if (parts[0] !== "v1") return undefined;
  if (parts.length > 9) return undefined;
  switch (parts[1]) {
    case "publish":
      return publishPath(parts);
    case "me":
      return meRoutes(parts.slice(2));
    case "signer":
      return signerRoutes(parts.slice(2));
    default:
      return publicPath(parts);
  }
}

/** The route `method` and `pathname` name; HEAD reads as GET. */
export function matchRoute(method: string, pathname: string): Matched {
  const found = routesFor(pathname);
  if (!found) return { refused: 404 };
  const asked = (method === "HEAD" ? "GET" : method) as keyof Methods;
  const route = found[asked];
  return route ? { route } : { refused: 405 };
}

/** Who may call a route, which also says which rate limit applies to it. */
export type RouteClass = "read" | "report" | "write" | "signer";
export function routeClass(route: Route): RouteClass {
  if (route.kind.startsWith("signer-")) return "signer";
  if (route.kind === "report") return "report";
  if (route.kind === "publish" || route.kind === "withdraw" || route.kind.startsWith("me"))
    return "write";
  return "read";
}

export const isSigner = (route: Route) => routeClass(route) === "signer";
/** Routes that read the public catalog: no sign-in, no cookie, cacheable. */
export const isPublicRead = (route: Route) => routeClass(route) === "read";
