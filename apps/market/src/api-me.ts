import type { Context } from "./context.ts";
import type { Route } from "./routes.ts";

/*
 * The publisher's own routes under `/v1/me` (ADR 0173 §2 to §5, §13): profile, handle, avatar,
 * pins, drafts, publications, transfers, signals, appeals and verification. Every one needs a
 * market grant through `authenticate`.
 */

export async function meRoute(
  request: Request,
  url: URL,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  void request;
  void url;
  void context;
  void route;
  return undefined;
}
