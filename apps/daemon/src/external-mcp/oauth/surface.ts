/*
 * Everything one base URL serves to outside clients (ADR 0117): the MCP endpoint, its
 * discovery documents and the OAuth endpoints. Every way in (loopback, Tailscale, ace's relay,
 * the person's own URL) hands its requests here with the base it arrived at; how a request
 * arrived never changes what it may do.
 */
import type { ResourceFetch } from "@ace/mcp-server";
import { relativePath, resourceOf, type OutsideBase } from "./base.ts";
import type { Authorizations } from "./authorize.ts";
import { authorizationServerMetadata, protectedResourceMetadata } from "./metadata.ts";
import { RateLimit } from "./rate-limit.ts";
import type { ClientRegistrations } from "./registrations.ts";
import { tokenRequest, type TokenDeps } from "./token.ts";

const maxFormBytes = 16 * 1024;
const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * Discovery, /token and /register answer browser-based clients from any origin, except
 * /register on loopback: a web page the person visits must not register a client against
 * this machine (it can't read the reply, so it can't go on to /authorize).
 */
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "600",
};

export interface SurfaceDeps {
  authorizations: Authorizations;
  registrations: ClientRegistrations;
  token: TokenDeps;
  machine(): string;
  now(): number;
}
/** Calls per minute to the endpoints anyone can call, per caller (or per way in). */
export const callLimits = { authorize: 20, register: 10 };

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
  return response;
}
/**
 * Whether a browser page from `origin` may call /mcp at `base` (DNS rebinding, MCP transport
 * security): no Origin (not a browser), the base's own origin, or a loopback page on the
 * loopback base.
 */
export function originAllowed(origin: string | null, base: OutsideBase): boolean {
  if (origin === null) return true;
  if (origin === new URL(base.url).origin) return true;
  if (base.path !== "local") return false;
  try {
    return loopbackNames.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}
async function boundedText(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > maxFormBytes) return undefined;
  const text = await request.text();
  return new TextEncoder().encode(text).length > maxFormBytes ? undefined : text;
}
function oauthError(status: number, error: string, description: string): Response {
  return withCors(
    Response.json(
      { error, error_description: description },
      { status, headers: { "cache-control": "no-store" } },
    ),
  );
}

function limited(): Response {
  return new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } });
}

export function outsideSurface(deps: SurfaceDeps) {
  const limits = {
    authorize: new RateLimit({ limit: callLimits.authorize, windowMs: 60_000, now: deps.now }),
    register: new RateLimit({ limit: callLimits.register, windowMs: 60_000, now: deps.now }),
  };
  /**
   * Serves one request at `base`. `peer` is the caller's address where the daemon sees it (the
   * Tailscale listener); loopback and ace's relay show none, so their limits are per base.
   */
  return async (
    request: Request,
    base: OutsideBase,
    mcp: ResourceFetch,
    peer?: string,
  ): Promise<Response> => {
    const path = relativePath(request, base);
    const method = request.method;
    const caller = peer ? `${base.url} ${peer}` : base.url;
    const browserRegistration = path === "/register" && base.path === "local";
    if (path === "/mcp") {
      if (!originAllowed(request.headers.get("origin"), base))
        return new Response("Origin not allowed", { status: 403 });
      return mcp(request, resourceOf(base));
    }
    const json = (body: unknown, status = 200) =>
      withCors(Response.json(body, { status, headers: { "cache-control": "no-store" } }));
    if (method === "OPTIONS")
      return browserRegistration
        ? new Response(null, { status: 204 })
        : withCors(new Response(null, { status: 204 }));
    switch (path) {
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return method === "GET"
          ? json(protectedResourceMetadata(base, deps.machine()))
          : new Response(null, { status: 405 });
      case "/.well-known/oauth-authorization-server":
        return method === "GET"
          ? json(authorizationServerMetadata(base))
          : new Response(null, { status: 405 });
      case "/authorize":
        if (method !== "GET") return new Response(null, { status: 405 });
        if (!limits.authorize.allow(caller)) return limited();
        return deps.authorizations.start(new URL(request.url).searchParams, base);
      case "/authorize/wait":
        return method === "GET"
          ? deps.authorizations.wait(new URL(request.url).searchParams)
          : new Response(null, { status: 405 });
      case "/token": {
        if (method !== "POST") return new Response(null, { status: 405 });
        const type = request.headers.get("content-type") ?? "";
        if (!type.startsWith("application/x-www-form-urlencoded"))
          return oauthError(400, "invalid_request", "Send the form as x-www-form-urlencoded.");
        const text = await boundedText(request);
        if (text === undefined) return oauthError(400, "invalid_request", "The form is too large.");
        return withCors(tokenRequest(new URLSearchParams(text), base, deps.token));
      }
      case "/register": {
        if (method !== "POST") return new Response(null, { status: 405 });
        if (!limits.register.allow(caller)) return limited();
        const answer = (response: Response) =>
          browserRegistration ? response : withCors(response);
        // JSON only (RFC 7591): a form a web page posts without asking first is refused.
        if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
          return answer(
            Response.json(
              { error: "invalid_client_metadata", error_description: "Send JSON." },
              { status: 400 },
            ),
          );
        const text = await boundedText(request);
        let body: unknown;
        try {
          body = text === undefined ? undefined : JSON.parse(text);
        } catch {
          body = undefined;
        }
        const result = deps.registrations.register(body);
        const headers = { "cache-control": "no-store" };
        return answer(
          "registered" in result
            ? Response.json(result.registered, { status: 201, headers })
            : Response.json(
                { error: result.error, error_description: result.description },
                { status: "status" in result ? result.status : 400, headers },
              ),
        );
      }
      default:
        return new Response(null, { status: 404 });
    }
  };
}
