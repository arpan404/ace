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
import type { ClientRegistrations } from "./registrations.ts";
import { tokenRequest, type TokenDeps } from "./token.ts";

const maxFormBytes = 16 * 1024;
const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Discovery, /token and /register answer browser-based clients from any origin. */
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
}

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

export function outsideSurface(deps: SurfaceDeps) {
  return async (request: Request, base: OutsideBase, mcp: ResourceFetch): Promise<Response> => {
    const path = relativePath(request, base);
    const method = request.method;
    if (path === "/mcp") {
      if (!originAllowed(request.headers.get("origin"), base))
        return new Response("Origin not allowed", { status: 403 });
      return mcp(request, resourceOf(base));
    }
    const json = (body: unknown, status = 200) =>
      withCors(Response.json(body, { status, headers: { "cache-control": "no-store" } }));
    if (method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
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
        return method === "GET"
          ? deps.authorizations.start(new URL(request.url).searchParams, base)
          : new Response(null, { status: 405 });
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
        const text = await boundedText(request);
        let body: unknown;
        try {
          body = text === undefined ? undefined : JSON.parse(text);
        } catch {
          body = undefined;
        }
        const result = deps.registrations.register(body);
        return "registered" in result
          ? json(result.registered, 201)
          : oauthError(400, result.error, result.description);
      }
      default:
        return new Response(null, { status: 404 });
    }
  };
}
