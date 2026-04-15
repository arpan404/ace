import Mime from "@effect/platform-node/Mime";
import Os from "node:os";
import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";
import { Data, Effect, FileSystem, Layer, Option, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { resolveAttachmentPathById } from "./attachmentStore";
import { ServerConfig } from "./config";
import {
  claimPairingSession,
  createPairingSession,
  getPairingClaim,
  getPairingSession,
  resolvePairingSession,
} from "./pairing";
import { GitHubCli } from "./git/Services/GitHubCli";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver";
import { WorkspacePaths } from "./workspace/Services/WorkspacePaths";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
const GITHUB_ISSUE_IMAGE_ROUTE = "/api/github-issue-image";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: http: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' ws: wss: http: https:; frame-src 'self' http: https:; media-src 'self' blob: data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
const PAIRING_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
} as const;

class GitHubIssueImageFetchError extends Data.TaggedError("GitHubIssueImageFetchError")<{
  readonly cause: unknown;
}> {}

const withSecurityHeaders = <T extends Parameters<typeof HttpServerResponse.setHeaders>[0]>(
  response: T,
) => HttpServerResponse.setHeaders(response, SECURITY_HEADERS);

const withPairingHeaders = <T extends Parameters<typeof HttpServerResponse.setHeaders>[0]>(
  response: T,
) => HttpServerResponse.setHeaders(withSecurityHeaders(response), PAIRING_CORS_HEADERS);

function respondJson(payload: unknown, options?: { readonly status?: number }) {
  return HttpServerResponse.text(JSON.stringify(payload), {
    status: options?.status ?? 200,
    contentType: "application/json; charset=utf-8",
  });
}

function readAuthTokenFromRequest(
  request: HttpServerRequest.HttpServerRequest,
  requestUrl: URL,
): string {
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return requestUrl.searchParams.get("token")?.trim() ?? "";
}

function requirePairingAuthorization(
  request: HttpServerRequest.HttpServerRequest,
  requestUrl: URL,
  authToken: string | undefined,
) {
  if (!authToken || authToken.length === 0) {
    return null;
  }
  const providedToken = readAuthTokenFromRequest(request, requestUrl);
  if (providedToken === authToken) {
    return null;
  }
  return withPairingHeaders(
    respondJson(
      {
        error: "Unauthorized pairing request.",
      },
      { status: 401 },
    ),
  );
}

function readPairingSessionId(pathname: string): string | null {
  const match = /^\/api\/pairing\/sessions\/([^/]+)$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function readPairingResolveSessionId(pathname: string): string | null {
  const match = /^\/api\/pairing\/sessions\/([^/]+)\/resolve$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function readPairingClaimId(pathname: string): string | null {
  const match = /^\/api\/pairing\/claims\/([^/]+)$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function readPairingErrorStatus(code: string): number {
  switch (code) {
    case "invalid-ws-url":
      return 400;
    case "invalid-secret":
      return 403;
    case "not-found":
      return 404;
    case "already-claimed":
      return 409;
    case "claim-missing":
      return 409;
    case "expired":
      return 410;
    default:
      return 400;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "::"
  );
}

function isPrivateIpv4(ipv4: string): boolean {
  return (
    ipv4.startsWith("10.") ||
    ipv4.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ipv4)
  );
}

function resolveLocalNetworkIpv4(): string | null {
  const interfaces = Os.networkInterfaces();
  let fallback: string | null = null;
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      if (entry.address.startsWith("169.254.")) {
        continue;
      }
      if (isPrivateIpv4(entry.address)) {
        return entry.address;
      }
      if (fallback === null) {
        fallback = entry.address;
      }
    }
  }
  return fallback;
}

function resolveAdvertisedRequestUrl(requestUrl: URL): URL {
  const advertised = new URL(requestUrl.toString());
  if (!isLoopbackHostname(advertised.hostname)) {
    return advertised;
  }
  const networkHost = resolveLocalNetworkIpv4();
  if (!networkHost) {
    return advertised;
  }
  advertised.hostname = networkHost;
  return advertised;
}

function resolvePairingClaimUrl(requestUrl: URL): URL | null {
  const advertised = resolveAdvertisedRequestUrl(requestUrl);
  if (isLoopbackHostname(advertised.hostname)) {
    return null;
  }
  return new URL("/api/pairing/claims", advertised);
}

function resolveSessionPollingUrl(sessionId: string, requestUrl: URL): string {
  const advertised = resolveAdvertisedRequestUrl(requestUrl);
  return new URL(`/api/pairing/sessions/${encodeURIComponent(sessionId)}`, advertised).toString();
}

function parsePairingWsUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveAdvertisedWsUrl(rawWsUrl: string, advertisedHost: string): string {
  const parsedWsUrl = parsePairingWsUrl(rawWsUrl);
  if (!parsedWsUrl) {
    return rawWsUrl;
  }
  if (!isLoopbackHostname(parsedWsUrl.hostname)) {
    return rawWsUrl;
  }
  parsedWsUrl.hostname = advertisedHost;
  return parsedWsUrl.toString();
}

function isSpaDocumentPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/index.html") {
    return true;
  }
  const lastSegment = pathname.split("/").pop() ?? "";
  return !lastSegment.includes(".");
}

function resolveBootstrapWsUrl(requestUrl: URL, authToken: string): string {
  const wsUrl = new URL(requestUrl.toString());
  wsUrl.protocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/";
  wsUrl.search = "";
  wsUrl.searchParams.set("token", authToken);
  return wsUrl.toString();
}

function resolveAllowedGitHubIssueImageUrl(rawUrl: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "github.com") {
    return parsed.pathname.startsWith("/user-attachments/") ? parsed : null;
  }
  if (hostname.endsWith(".githubusercontent.com") || hostname.endsWith(".githubassets.com")) {
    return parsed;
  }
  return null;
}

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return withSecurityHeaders(HttpServerResponse.text("Bad Request", { status: 400 }));
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return withSecurityHeaders(
        HttpServerResponse.text("Invalid attachment path", { status: 400 }),
      );
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return withSecurityHeaders(
        HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
          status: isIdLookup ? 404 : 400,
        }),
      );
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return withSecurityHeaders(HttpServerResponse.text("Not Found", { status: 404 }));
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.map(withSecurityHeaders),
      Effect.catch(() =>
        Effect.succeed(
          withSecurityHeaders(HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      ),
    );
  }),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return withSecurityHeaders(HttpServerResponse.text("Bad Request", { status: 400 }));
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return withSecurityHeaders(HttpServerResponse.text("Missing cwd parameter", { status: 400 }));
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return withSecurityHeaders(
        HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
          status: 200,
          contentType: "image/svg+xml",
          headers: {
            "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
          },
        }),
      );
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.map(withSecurityHeaders),
      Effect.catch(() =>
        Effect.succeed(
          withSecurityHeaders(HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      ),
    );
  }),
);

export const workspaceFileRouteLayer = HttpRouter.add(
  "GET",
  "/api/workspace-file",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return withSecurityHeaders(HttpServerResponse.text("Bad Request", { status: 400 }));
    }

    const cwd = url.value.searchParams.get("cwd");
    const relativePath = url.value.searchParams.get("relativePath");
    if (!cwd || !relativePath) {
      return withSecurityHeaders(
        HttpServerResponse.text("Missing cwd or relativePath parameter", { status: 400 }),
      );
    }

    const workspacePaths = yield* WorkspacePaths;
    const normalizedRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(cwd)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!normalizedRoot) {
      return withSecurityHeaders(
        HttpServerResponse.text("Workspace root is unavailable.", { status: 400 }),
      );
    }

    const resolvedPath = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: normalizedRoot,
        relativePath,
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!resolvedPath) {
      return withSecurityHeaders(
        HttpServerResponse.text("Invalid workspace file path.", { status: 400 }),
      );
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(resolvedPath.absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo) {
      return withSecurityHeaders(HttpServerResponse.text("Not Found", { status: 404 }));
    }
    if (fileInfo.type !== "File") {
      return withSecurityHeaders(
        HttpServerResponse.text("Only files can be previewed.", { status: 400 }),
      );
    }
    if (fileInfo.size > WORKSPACE_FILE_PREVIEW_MAX_BYTES) {
      return withSecurityHeaders(
        HttpServerResponse.text(
          `Files larger than ${Math.round(WORKSPACE_FILE_PREVIEW_MAX_BYTES / (1024 * 1024))}MB cannot be previewed.`,
          { status: 413 },
        ),
      );
    }

    return yield* HttpServerResponse.file(resolvedPath.absolutePath, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }).pipe(
      Effect.map(withSecurityHeaders),
      Effect.catch(() =>
        Effect.succeed(
          withSecurityHeaders(HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      ),
    );
  }),
);

export const githubIssueImageRouteLayer = HttpRouter.add(
  "GET",
  GITHUB_ISSUE_IMAGE_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return withSecurityHeaders(HttpServerResponse.text("Bad Request", { status: 400 }));
    }

    const cwd = requestUrl.value.searchParams.get("cwd");
    const rawUrl = requestUrl.value.searchParams.get("url");
    if (!cwd || !rawUrl) {
      return withSecurityHeaders(
        HttpServerResponse.text("Missing cwd or url parameter", { status: 400 }),
      );
    }

    const allowedUrl = resolveAllowedGitHubIssueImageUrl(rawUrl);
    if (!allowedUrl) {
      return withSecurityHeaders(HttpServerResponse.text("Unsupported image URL", { status: 400 }));
    }

    const gitHubCli = yield* GitHubCli;
    const authToken = yield* gitHubCli
      .execute({
        cwd,
        args: ["auth", "token"],
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.catch(() => Effect.succeed("")),
      );

    const fetchRemote = (token: string) =>
      Effect.tryPromise({
        try: () =>
          fetch(allowedUrl, {
            headers: {
              Accept: "image/*,*/*;q=0.8",
              ...(token.length > 0 ? { Authorization: `Bearer ${token}` } : {}),
            },
            redirect: "follow",
          }),
        catch: (cause) => new GitHubIssueImageFetchError({ cause }),
      });

    const response = yield* fetchRemote(authToken).pipe(
      Effect.flatMap((result) =>
        !result.ok && authToken.length > 0 ? fetchRemote("") : Effect.succeed(result),
      ),
      Effect.catch(() => Effect.succeed(null)),
    );

    if (!response || !response.ok) {
      return withSecurityHeaders(HttpServerResponse.text("Unable to load image", { status: 502 }));
    }

    const contentType =
      response.headers.get("content-type") ?? Mime.getType(allowedUrl.pathname) ?? "image/*";
    const data = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
    return withSecurityHeaders(
      HttpServerResponse.uint8Array(data, {
        status: 200,
        contentType,
        headers: {
          "Cache-Control": "private, no-store",
        },
      }),
    );
  }),
);

const pairingOptionsRouteLayer = HttpRouter.add(
  "OPTIONS",
  "/api/pairing/*",
  Effect.succeed(withPairingHeaders(HttpServerResponse.empty({ status: 204 }))),
);

const pairingAdvertisedEndpointRouteLayer = HttpRouter.add(
  "GET",
  "/api/pairing/advertised-endpoint",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return withPairingHeaders(respondJson({ error: "Bad Request" }, { status: 400 }));
    }
    const config = yield* ServerConfig;
    const unauthorized = requirePairingAuthorization(request, requestUrl.value, config.authToken);
    if (unauthorized) {
      return unauthorized;
    }
    const requestedWsUrl = requestUrl.value.searchParams.get("wsUrl")?.trim();
    if (!requestedWsUrl) {
      return withPairingHeaders(
        respondJson({ error: "Pairing endpoint requires wsUrl query parameter." }, { status: 400 }),
      );
    }
    if (!parsePairingWsUrl(requestedWsUrl)) {
      return withPairingHeaders(
        respondJson({ error: "Pairing endpoint wsUrl is invalid." }, { status: 400 }),
      );
    }
    const advertisedRequestUrl = resolveAdvertisedRequestUrl(requestUrl.value);
    const advertisedWsUrl = resolveAdvertisedWsUrl(requestedWsUrl, advertisedRequestUrl.hostname);
    return withPairingHeaders(
      respondJson({
        wsUrl: advertisedWsUrl,
      }),
    );
  }),
);

const pairingCreateSessionRouteLayer = HttpRouter.add(
  "POST",
  "/api/pairing/sessions",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return withPairingHeaders(respondJson({ error: "Bad Request" }, { status: 400 }));
    }
    const config = yield* ServerConfig;
    const unauthorized = requirePairingAuthorization(request, requestUrl.value, config.authToken);
    if (unauthorized) {
      return unauthorized;
    }
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    if (!body || typeof body !== "object") {
      return withPairingHeaders(
        respondJson({ error: "Pairing session body must be a JSON object." }, { status: 400 }),
      );
    }
    const payload = body as { wsUrl?: unknown; name?: unknown };
    if (typeof payload.wsUrl !== "string") {
      return withPairingHeaders(
        respondJson({ error: "Pairing session requires a wsUrl string." }, { status: 400 }),
      );
    }
    const advertisedRequestUrl = resolveAdvertisedRequestUrl(requestUrl.value);
    const pairingWsUrl = resolveAdvertisedWsUrl(payload.wsUrl, advertisedRequestUrl.hostname);
    const created = createPairingSession({
      wsUrl: pairingWsUrl,
      authToken: config.authToken ?? "",
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    });
    if (!created.ok) {
      return withPairingHeaders(
        respondJson({ error: created.message }, { status: readPairingErrorStatus(created.code) }),
      );
    }
    const claimUrl = resolvePairingClaimUrl(requestUrl.value);
    const pollingUrl = resolveSessionPollingUrl(created.value.sessionId, requestUrl.value);
    return withPairingHeaders(
      respondJson({
        ...created.value,
        ...(claimUrl ? { claimUrl: claimUrl.toString() } : {}),
        pollingUrl,
      }),
    );
  }),
);

const pairingGetSessionRouteLayer = HttpRouter.add(
  "GET",
  "/api/pairing/sessions/:sessionId",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return withPairingHeaders(respondJson({ error: "Bad Request" }, { status: 400 }));
    }
    const sessionId = readPairingSessionId(requestUrl.value.pathname);
    if (!sessionId) {
      return withPairingHeaders(
        respondJson({ error: "Pairing session was not found." }, { status: 404 }),
      );
    }
    const session = getPairingSession(sessionId);
    if (!session.ok) {
      return withPairingHeaders(
        respondJson({ error: session.message }, { status: readPairingErrorStatus(session.code) }),
      );
    }
    return withPairingHeaders(respondJson(session.value));
  }),
);

const pairingResolveSessionRouteLayer = HttpRouter.add(
  "POST",
  "/api/pairing/sessions/:sessionId/resolve",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return withPairingHeaders(respondJson({ error: "Bad Request" }, { status: 400 }));
    }
    const sessionId = readPairingResolveSessionId(requestUrl.value.pathname);
    if (!sessionId) {
      return withPairingHeaders(
        respondJson({ error: "Pairing session was not found." }, { status: 404 }),
      );
    }
    const config = yield* ServerConfig;
    const unauthorized = requirePairingAuthorization(request, requestUrl.value, config.authToken);
    if (unauthorized) {
      return unauthorized;
    }
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    if (!body || typeof body !== "object") {
      return withPairingHeaders(
        respondJson({ error: "Pairing resolve body must be a JSON object." }, { status: 400 }),
      );
    }
    const payload = body as { approve?: unknown };
    if (typeof payload.approve !== "boolean") {
      return withPairingHeaders(
        respondJson(
          { error: "Pairing resolve request requires an approve boolean." },
          { status: 400 },
        ),
      );
    }
    const resolved = resolvePairingSession({
      sessionId,
      approve: payload.approve,
    });
    if (!resolved.ok) {
      return withPairingHeaders(
        respondJson({ error: resolved.message }, { status: readPairingErrorStatus(resolved.code) }),
      );
    }
    return withPairingHeaders(respondJson(resolved.value));
  }),
);

const pairingCreateClaimRouteLayer = HttpRouter.add(
  "POST",
  "/api/pairing/claims",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return withPairingHeaders(respondJson({ error: "Bad Request" }, { status: 400 }));
    }
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    if (!body || typeof body !== "object") {
      return withPairingHeaders(
        respondJson({ error: "Pairing claim body must be a JSON object." }, { status: 400 }),
      );
    }
    const payload = body as { sessionId?: unknown; secret?: unknown; requesterName?: unknown };
    if (typeof payload.sessionId !== "string" || typeof payload.secret !== "string") {
      return withPairingHeaders(
        respondJson(
          { error: "Pairing claim requires sessionId and secret strings." },
          { status: 400 },
        ),
      );
    }
    const claimed = claimPairingSession({
      sessionId: payload.sessionId,
      secret: payload.secret,
      ...(typeof payload.requesterName === "string"
        ? { requesterName: payload.requesterName }
        : {}),
    });
    if (!claimed.ok) {
      return withPairingHeaders(
        respondJson({ error: claimed.message }, { status: readPairingErrorStatus(claimed.code) }),
      );
    }
    const autoApproved = resolvePairingSession({
      sessionId: payload.sessionId,
      approve: true,
    });
    if (!autoApproved.ok) {
      return withPairingHeaders(
        respondJson(
          { error: autoApproved.message },
          { status: readPairingErrorStatus(autoApproved.code) },
        ),
      );
    }
    const advertisedRequestUrl = resolveAdvertisedRequestUrl(requestUrl.value);
    const pollUrl = new URL(
      `/api/pairing/claims/${encodeURIComponent(claimed.value.claimId)}`,
      advertisedRequestUrl,
    ).toString();
    return withPairingHeaders(
      respondJson({
        ...claimed.value,
        pollUrl,
      }),
    );
  }),
);

const pairingGetClaimRouteLayer = HttpRouter.add(
  "GET",
  "/api/pairing/claims/:claimId",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return withPairingHeaders(respondJson({ error: "Bad Request" }, { status: 400 }));
    }
    const claimId = readPairingClaimId(requestUrl.value.pathname);
    if (!claimId) {
      return withPairingHeaders(
        respondJson({ error: "Pairing claim was not found." }, { status: 404 }),
      );
    }
    const claim = getPairingClaim(claimId);
    if (!claim.ok) {
      return withPairingHeaders(
        respondJson({ error: claim.message }, { status: readPairingErrorStatus(claim.code) }),
      );
    }
    return withPairingHeaders(respondJson(claim.value));
  }),
);

export const pairingRouteLayer = Layer.mergeAll(
  pairingOptionsRouteLayer,
  pairingAdvertisedEndpointRouteLayer,
  pairingCreateSessionRouteLayer,
  pairingGetSessionRouteLayer,
  pairingResolveSessionRouteLayer,
  pairingCreateClaimRouteLayer,
  pairingGetClaimRouteLayer,
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return withSecurityHeaders(HttpServerResponse.text("Bad Request", { status: 400 }));
    }

    const config = yield* ServerConfig;
    if (config.devUrl) {
      return withSecurityHeaders(HttpServerResponse.redirect(config.devUrl.href, { status: 302 }));
    }
    const authToken = config.authToken?.trim() ?? "";
    const hasBootstrapWsUrl = url.value.searchParams.has(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM);
    if (authToken.length > 0 && !hasBootstrapWsUrl && isSpaDocumentPath(url.value.pathname)) {
      const redirected = new URL(url.value.toString());
      redirected.searchParams.set(
        DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM,
        resolveBootstrapWsUrl(url.value, authToken),
      );
      return withSecurityHeaders(
        HttpServerResponse.redirect(redirected.toString(), { status: 302 }),
      );
    }

    if (!config.staticDir) {
      return withSecurityHeaders(
        HttpServerResponse.text("No static directory configured and no dev URL set.", {
          status: 503,
        }),
      );
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return withSecurityHeaders(
        HttpServerResponse.text("Invalid static file path", { status: 400 }),
      );
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return withSecurityHeaders(
        HttpServerResponse.text("Invalid static file path", { status: 400 }),
      );
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return withSecurityHeaders(
          HttpServerResponse.text("Invalid static file path", { status: 400 }),
        );
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return withSecurityHeaders(HttpServerResponse.text("Not Found", { status: 404 }));
      }
      return withSecurityHeaders(
        HttpServerResponse.uint8Array(indexData, {
          status: 200,
          contentType: "text/html; charset=utf-8",
        }),
      );
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return withSecurityHeaders(HttpServerResponse.text("Internal Server Error", { status: 500 }));
    }

    return withSecurityHeaders(
      HttpServerResponse.uint8Array(data, {
        status: 200,
        contentType,
      }),
    );
  }),
);
