import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Option, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { resolveAttachmentPathById } from "./attachmentStore";
import { ServerConfig } from "./config";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver";
import { WorkspacePaths } from "./workspace/Services/WorkspacePaths";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self' ws: wss: http: https:; frame-src 'self' http: https:; media-src 'self' blob: data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const withSecurityHeaders = <T extends Parameters<typeof HttpServerResponse.setHeaders>[0]>(
  response: T,
) => HttpServerResponse.setHeaders(response, SECURITY_HEADERS);

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
