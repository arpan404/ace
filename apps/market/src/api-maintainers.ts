import type { Context } from "./context.ts";
import type { Route } from "./routes.ts";

/*
 * The signer's maintainer routes (ADR 0173 §9, §10, §13, §14): the queue, the scan context,
 * holds, blocks, listing edits, publishers, collections, the blocklist, the verified and official
 * lists, reports and appeals. Behind the signer's token.
 */

export async function maintainerRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  void request;
  void route;
  void context;
  return undefined;
}
