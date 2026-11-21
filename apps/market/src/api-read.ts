import type { Route } from "./routes.ts";
import type { Context } from "./context.ts";
import { objectKey } from "./context.ts";
import { entryPage, featuredEntries, indexBody, parseSince, searchInput } from "./catalog.ts";
import { etagOf, failure, notFound } from "./http.ts";
import { searchSort, searchSorted } from "./store/discover.ts";
import { countDownload } from "./store/downloads.ts";
import { categories, listedWithHash, signedVersion, withdrawnList } from "./store/read.ts";
import { privateHeaders } from "./registry-access.ts";

/*
 * The catalog API (ADR 0168 §3, ADR 0174 §6): no sign-in, no cookie, and nothing kept about who
 * asked. A download raises its version's anonymous totals (all time, per hour, per day) and
 * nothing else; a caller past the DOWNLOADS binding, keyed by address and hash in the binding's
 * own memory, still gets the bytes and isn't counted.
 */

const revalidate = { "cache-control": "public, max-age=0, must-revalidate" };

/**
 * JSON with a strong ETag; 304 when the caller already has these bytes. A registry's answer
 * (`members`) is never kept by a shared cache.
 */
export async function tagged(request: Request, body: unknown, members = false): Promise<Response> {
  const text = JSON.stringify(body);
  const etag = await etagOf(text);
  const headers = { ...(members ? privateHeaders : revalidate), etag };
  if (request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers });
  return new Response(text, {
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

export async function readRoute(
  request: Request,
  url: URL,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  const dbs = context.dbs;
  switch (route.kind) {
    case "index": {
      const since = parseSince(url.searchParams.get("since"));
      if (since === "invalid") return failure(400, "invalid", "since must be a stamp.");
      return tagged(request, await indexBody(dbs, since));
    }
    case "search":
      return tagged(
        request,
        await searchSorted(
          dbs,
          searchInput(url.searchParams),
          searchSort(url.searchParams.get("sort")),
        ),
      );
    case "categories":
      return tagged(request, { categories: await categories(dbs.lists) });
    case "featured": {
      const entries = await featuredEntries(dbs);
      return tagged(request, {
        entries: entries.map((entry) => ({ type: entry.type, name: entry.name })),
      });
    }
    // A public name is never a registry's stored one: these reach the public market only.
    case "entry": {
      const page = await entryPage(dbs, route.type, route.name);
      if (!page) return notFound();
      const { row: _row, ...body } = page;
      return tagged(request, body);
    }
    case "version": {
      const db = dbs.catalogue(route.type);
      const signed = db ? await signedVersion(db, route) : undefined;
      return signed ? tagged(request, signed) : notFound();
    }
    case "withdrawn": {
      const list = await withdrawnList(dbs.lists);
      return list ? tagged(request, list.signed) : notFound();
    }
    case "object":
      return object(request, route.hash, "public", context);
    default:
      return undefined;
  }
}

/**
 * An archive by its hash, for `audience`'s readers: the public market's, or a registry's, whose
 * route has authorized its member first.
 */
export async function object(
  request: Request,
  hash: string,
  audience: string,
  context: Context,
): Promise<Response> {
  const copies = await listedWithHash(context.dbs, hash, audience);
  const members = audience !== "public";
  if (copies.length === 0) return notFound();
  const headers = {
    "content-type": "application/x-tar",
    "cache-control": members
      ? privateHeaders["cache-control"]
      : "public, max-age=31536000, immutable",
    etag: `"${hash}"`,
  };
  if (request.headers.get("if-none-match") === headers.etag)
    return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") {
    const head = await context.env.OBJECTS.head(objectKey(hash));
    return head
      ? new Response(null, { headers: { ...headers, "content-length": String(head.size) } })
      : notFound();
  }
  const stored = await context.env.OBJECTS.get(objectKey(hash));
  if (!stored) return notFound();
  if (await counted(request, hash, context))
    context.waitUntil(countDownload(context.dbs.counts, copies, context.now));
  return new Response(stored.body, {
    headers: { ...headers, "content-length": String(stored.size) },
  });
}

/** Whether this fetch counts: once per caller and hash per the binding's window. */
async function counted(request: Request, hash: string, context: Context): Promise<boolean> {
  const limit = context.env.DOWNLOADS;
  if (!limit) return true;
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  return (await limit.limit({ key: `${address}:${hash}` })).success;
}
