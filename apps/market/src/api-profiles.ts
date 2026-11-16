import type { Context } from "./context.ts";
import type { Route } from "./routes.ts";

/* Public profile reads (ADR 0173 §3): a publisher's page, avatars and listing pictures. */

export async function profileRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  void request;
  void route;
  void context;
  return undefined;
}
