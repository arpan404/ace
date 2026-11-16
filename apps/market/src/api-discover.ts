import type { Context } from "./context.ts";
import type { Route } from "./routes.ts";

/*
 * Discover and the open writes and lists (ADR 0173 §6, §7, §8, §13, §14): `/v1/discover`, the
 * anonymous report, and the signed blocklist, verified and official lists.
 */

export async function discoverRoute(
  request: Request,
  url: URL,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  void request;
  void url;
  void route;
  void context;
  return undefined;
}
