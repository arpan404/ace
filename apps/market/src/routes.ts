import {
  MarketEntryName,
  MarketEntryType,
  MarketHash,
  MarketVersion,
} from "@ace/protocol/marketplace";

/*
 * Which route a request names (ADR 0168 §3, §7; the publishing and signer contract is in
 * @ace/marketplace's service-wire.ts). Pure: a method and a path in, a route or a refusal out.
 * A path segment that isn't a valid type, name, version or hash names nothing.
 */

export interface EntryKey {
  type: MarketEntryType;
  name: string;
}
export interface VersionKey extends EntryKey {
  version: string;
}

export type Route =
  | { kind: "index" }
  | { kind: "search" }
  | { kind: "categories" }
  | { kind: "featured" }
  | { kind: "withdrawn" }
  | ({ kind: "entry" } & EntryKey)
  | ({ kind: "version" } & VersionKey)
  | { kind: "object"; hash: string }
  | ({ kind: "publish" } & EntryKey)
  | ({ kind: "withdraw" } & VersionKey)
  | { kind: "signer-pending" }
  | { kind: "signer-object"; hash: string }
  | ({ kind: "signer-version" } & VersionKey)
  | ({ kind: "signer-review" } & VersionKey)
  | { kind: "signer-withdrawn" }
  | { kind: "signer-categories" }
  | { kind: "signer-featured" }
  | { kind: "page-home" }
  | { kind: "page-search" }
  | ({ kind: "page-entry" } & EntryKey);

export type Matched = { route: Route } | { refused: 404 | 405 };

const type = (value: string | undefined) => MarketEntryType.safeParse(value).data;
const name = (value: string | undefined) => MarketEntryName.safeParse(value).data;
const version = (value: string | undefined) => MarketVersion.safeParse(value).data;
const hash = (value: string | undefined) => MarketHash.safeParse(value).data;

function entryKey(typeSegment: string | undefined, nameSegment: string | undefined) {
  const t = type(typeSegment);
  const n = name(nameSegment);
  return t && n ? { type: t, name: n } : undefined;
}
function versionKey(
  typeSegment: string | undefined,
  nameSegment: string | undefined,
  versionSegment: string | undefined,
) {
  const entry = entryKey(typeSegment, nameSegment);
  const v = version(versionSegment);
  return entry && v ? { ...entry, version: v } : undefined;
}

/** The route for `method` and `pathname`, before the method is checked. */
function byPath(pathname: string): { method: string; route: Route } | undefined {
  const parts = pathname.split("/").slice(1);
  if (pathname === "/") return { method: "GET", route: { kind: "page-home" } };
  if (parts[0] !== "v1") {
    if (parts.length === 1 && parts[0] === "search")
      return { method: "GET", route: { kind: "page-search" } };
    const entry = parts.length === 2 ? entryKey(parts[0], parts[1]) : undefined;
    return entry ? { method: "GET", route: { kind: "page-entry", ...entry } } : undefined;
  }
  const [, first, a, b, c, d, e, ...rest] = parts;
  if (rest.length > 0) return undefined;
  const get = (route: Route) => ({ method: "GET", route });
  const post = (route: Route) => ({ method: "POST", route });
  const only = (count: number) => parts.length === count;
  switch (first) {
    case "index":
      return only(2) ? get({ kind: "index" }) : undefined;
    case "search":
      return only(2) ? get({ kind: "search" }) : undefined;
    case "categories":
      return only(2) ? get({ kind: "categories" }) : undefined;
    case "featured":
      return only(2) ? get({ kind: "featured" }) : undefined;
    case "withdrawn":
      return only(2) ? get({ kind: "withdrawn" }) : undefined;
    case "entries": {
      if (only(4)) {
        const entry = entryKey(a, b);
        return entry ? get({ kind: "entry", ...entry }) : undefined;
      }
      const key = only(5) ? versionKey(a, b, c) : undefined;
      return key ? get({ kind: "version", ...key }) : undefined;
    }
    case "objects": {
      const h = only(3) ? hash(a) : undefined;
      return h ? get({ kind: "object", hash: h }) : undefined;
    }
    case "publish": {
      if (c !== "versions") return undefined;
      if (only(5)) {
        const entry = entryKey(a, b);
        return entry ? post({ kind: "publish", ...entry }) : undefined;
      }
      const key = only(7) && e === "withdraw" ? versionKey(a, b, d) : undefined;
      return key ? post({ kind: "withdraw", ...key }) : undefined;
    }
    case "signer":
      return signerPath(parts.length, a, b, c, d);
    default:
      return undefined;
  }
}

function signerPath(
  length: number,
  a: string | undefined,
  b: string | undefined,
  c: string | undefined,
  d: string | undefined,
): { method: string; route: Route } | undefined {
  if (length === 3) {
    if (a === "pending") return { method: "GET", route: { kind: "signer-pending" } };
    if (a === "withdrawn") return { method: "PUT", route: { kind: "signer-withdrawn" } };
    if (a === "categories") return { method: "PUT", route: { kind: "signer-categories" } };
    if (a === "featured") return { method: "PUT", route: { kind: "signer-featured" } };
    return undefined;
  }
  if (length === 4 && a === "objects") {
    const h = hash(b);
    return h ? { method: "GET", route: { kind: "signer-object", hash: h } } : undefined;
  }
  if (length === 6 && (a === "versions" || a === "reviews")) {
    const key = versionKey(b, c, d);
    if (!key) return undefined;
    return {
      method: "PUT",
      route: { kind: a === "versions" ? "signer-version" : "signer-review", ...key },
    };
  }
  return undefined;
}

/** The route `method` and `pathname` name; HEAD reads as GET. */
export function matchRoute(method: string, pathname: string): Matched {
  const found = byPath(pathname);
  if (!found) return { refused: 404 };
  const asked = method === "HEAD" ? "GET" : method;
  return asked === found.method ? { route: found.route } : { refused: 405 };
}

export const isSigner = (route: Route) => route.kind.startsWith("signer-");
/** Routes that read the public catalog: no sign-in, no cookie, cacheable. */
export const isPublicRead = (route: Route) =>
  !isSigner(route) && route.kind !== "publish" && route.kind !== "withdraw";
