import type { IncomingMessage, ServerResponse } from "node:http";
import { ThreadId } from "@ace/protocol";
import { decide, host, tree, unplaced, type Operation, type Resource } from "./decide.ts";
import { refusalMessage } from "./gate.ts";
import { principal, type Principal } from "./principal.ts";
import type { TreeResolver } from "./trees.ts";

/*
 * The daemon's HTTP routes under the access policy (ADR 0209 §4.1, §4.2 "HTTP"). The bearer
 * resolves to a principal as a socket does: the host's token is `host`, so it gets no member
 * attachment, upload or preview; a paired device's bearer is nobody on an org host. A member's
 * request would carry a proof for that request; no client sends one yet, so none is a member.
 * A path listed nowhere here is refused on an org host.
 */

type Route = { operation: Operation; resource: Resource };

const threadOf = (segment: string | undefined): Resource => {
  const parsed = ThreadId.safeParse(segment);
  return parsed.success ? tree({ thread: parsed.data }) : unplaced;
};

/** What a request is, or undefined when nobody classified its path. */
export function httpRoute(method: string, path: string, remote: boolean): Route | undefined {
  const parts = path.split("/").slice(1);
  // Routes that authenticate with their own credential, decided where it is checked: ace MCP's
  // lease (per tool, `mcp-operations.ts`), Spade's grant, a Suit URL's grant, and the static
  // renderer, which serves no member content.
  if (!remote && (path === "/mcp" || path.startsWith("/spade/")))
    return { operation: "session", resource: host };
  if (path.startsWith("/v1/suits/")) return { operation: "session", resource: host };
  if (!path.startsWith("/v1/") && !path.startsWith("/preview/"))
    return { operation: "session", resource: host };
  if (parts[1] === "attachments")
    return parts[3] === "upload" || method === "POST"
      ? { operation: "tree.write", resource: threadOf(parts[2]) }
      : { operation: "tree.read", resource: threadOf(parts[2]) };
  if (parts[1] === "previews" || path.startsWith("/preview/"))
    return { operation: "tree.read", resource: unplaced };
  if (parts[1] === "icons") return { operation: "host.meta", resource: host };
  if (path === "/v1/status") return { operation: "host.meta", resource: host };
  if (path === "/v1/pair" || path === "/v1/pairings" || path === "/v1/tickets")
    return { operation: "pairing", resource: host };
  if (parts[1] === "machine-calls") return { operation: "fleet.link", resource: host };
  if (parts[1] === "transfers") return { operation: "transfer", resource: host };
  if (
    path === "/v1/stop" ||
    path.startsWith("/v1/maintenance") ||
    path === "/v1/app-update" ||
    path.startsWith("/v1/ace-account") ||
    path === "/v1/machine-code" ||
    path.startsWith("/v1/devices")
  )
    return { operation: "host.admin", resource: host };
  return undefined;
}

/** `/login` is the CLI's sign-in hand-off on loopback: it runs the daemon. */
const loginPath = (path: string) => path === "/login" || path.startsWith("/login?");

export type HttpGateDeps = {
  org: () => string | undefined;
  trees: TreeResolver;
  /** Whether `token` is the daemon's own. */
  hostToken: (token: string) => boolean;
};

const bearerOf = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
};

/** Who an HTTP request is: the host's operator by its token on loopback, otherwise nobody. */
export function httpPrincipal(
  request: IncomingMessage,
  remote: boolean,
  deps: HttpGateDeps,
): Principal {
  const token = bearerOf(request);
  return principal({
    org: deps.org(),
    hostToken: !remote && token !== undefined && deps.hostToken(token),
  });
}

/** Whether the policy lets `request` through; true on a person's machine. */
export function httpAllowed(request: IncomingMessage, remote: boolean, deps: HttpGateDeps) {
  if (deps.org() === undefined) return { allowed: true } as const;
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  const route = loginPath(path)
    ? ({ operation: "host.admin", resource: host } as const)
    : httpRoute(request.method ?? "GET", path, remote);
  return decide(
    httpPrincipal(request, remote, deps),
    route?.operation,
    route?.resource ?? unplaced,
    deps.trees,
  );
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** Wraps a request chain so an org host decides each request before any route reads it. */
export function orgHttpGate(remote: boolean, deps: HttpGateDeps, next: Handler): Handler {
  return (request, response) => {
    const decision = httpAllowed(request, remote, deps);
    if (decision.allowed) return next(request, response);
    request.resume();
    response.writeHead(403, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: "org_host_refused", message: refusalMessage(decision.reason) }),
    );
  };
}
