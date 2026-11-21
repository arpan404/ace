import { MarketReportRequest } from "@ace/protocol/marketplace";
import type { Context } from "./context.ts";
import { etagOf, failure, json, notFound, readJson } from "./http.ts";
import type { Route } from "./routes.ts";
import { discoverBody } from "./store/discover.ts";
import { listDb, signedList, type ListTable } from "./store/lists.ts";
import { fileReport } from "./store/reports.ts";

/*
 * Discover and the open writes and lists (ADR 0174 §6, §7, §8, §13, §14): `/v1/discover`, the
 * anonymous report, and the signed blocklist, verified and official lists and the terms
 * notices (ADR 0205 §4). No sign-in, no
 * cookie; a report keeps no address or account, and the REPORTS binding limits callers in its
 * own memory before this runs.
 */

async function tagged(request: Request, body: unknown): Promise<Response> {
  const text = JSON.stringify(body);
  const etag = await etagOf(text);
  const headers = { "cache-control": "public, max-age=0, must-revalidate", etag };
  if (request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers });
  return new Response(text, {
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

async function list(request: Request, context: Context, table: ListTable) {
  const stored = await signedList(listDb(context.dbs, table), table);
  return stored ? tagged(request, stored.signed) : notFound();
}

export async function discoverRoute(
  request: Request,
  _url: URL,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  switch (route.kind) {
    case "discover":
      return tagged(request, await discoverBody(context.dbs, context.now));
    case "blocklist":
    case "verified":
    case "official":
    case "notices":
      return list(request, context, route.kind);
    case "report": {
      const report = MarketReportRequest.safeParse(await readJson(request, 16 * 1024));
      if (!report.success)
        return failure(
          400,
          "invalid",
          "A report names an entry and one of the reasons, with a note of at most 1,000 characters.",
        );
      const filed = await fileReport(context.dbs, report.data, context.newId("rpt"), context.now);
      if (filed === "missing") return notFound();
      if (filed === "full")
        return failure(
          429,
          "busy",
          "This entry already has as many open reports as it holds; maintainers are on it.",
        );
      return json({ status: "done" }, 202);
    }
    default:
      return undefined;
  }
}
