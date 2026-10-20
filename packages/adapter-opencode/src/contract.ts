import { z } from "zod";
import { parseCliVersion } from "@ace/provider-kit/cli-versions";
import {
  admitsVersion,
  checkCli,
  CliTooOldError,
  cliRequirements,
} from "@ace/provider-kit/cli-requirements";

/**
 * The OpenCode v2 HTTP contract ace drives through `@opencode/client` 2.0.22.
 *
 * Patch releases are admitted by range, not by an exact allowlist: OpenCode 2.0.x
 * ships additive changes (new optional fields, new operations, new error variants),
 * and the client only depends on the method and route of each operation below.
 * The server's own OpenAPI document is probed at startup, so a patch that really
 * moves or drops one of these operations is still refused, naming what changed.
 */
export const minimumVersion = cliRequirements.opencode.minimum;
export const supportedRange = `OpenCode 2.0.x, ${minimumVersion} or newer`;

export const requiredRoutes: Readonly<Record<string, string>> = {
  "server.info": "GET /api/info",
  "event.subscribe": "GET /api/event",
  "session.create": "POST /api/session",
  "session.get": "GET /api/session/{sessionID}",
  "session.switchModel": "POST /api/session/{sessionID}/model",
  "session.list": "GET /api/session",
  "session.active": "GET /api/session/active",
  "session.prompt": "POST /api/session/{sessionID}/prompt",
  "session.interrupt": "POST /api/session/{sessionID}/interrupt",
  "session.message.list": "GET /api/session/{sessionID}/message",
  "session.permission.list": "GET /api/session/{sessionID}/permission",
  "session.permission.reply": "POST /api/session/{sessionID}/permission/{requestID}/reply",
  "session.form.list": "GET /api/session/{sessionID}/form",
  "session.form.reply": "POST /api/session/{sessionID}/form/{formID}/reply",
  "session.form.cancel": "DELETE /api/session/{sessionID}/form/{formID}",
  "session.inbox.list": "GET /api/session/{sessionID}/inbox",
  "shell.list": "GET /api/shell",
  "shell.get": "GET /api/shell/{id}",
  "shell.remove": "DELETE /api/shell/{id}",
  "model.list": "GET /api/model",
};

/** The 2.0 release line, whose API ace drives; a newer line is a different contract, not "too old". */
function checkedLine(value: string): boolean {
  const parsed = parseCliVersion(value);
  return parsed?.major === 2 && parsed.minor === 0 && !parsed.prerelease.length;
}

/** True for OpenCode 2.0.x at or above the minimum; the contract probe decides the rest. */
export function version(value: unknown): boolean {
  return typeof value === "string" && admitsVersion("opencode", value) && checkedLine(value);
}

/**
 * Why an installed OpenCode is refused before its contract is probed. Older than the minimum is
 * a `CliTooOldError`; a newer line ace hasn't checked (or an unreadable version) is
 * `cli_unsupported`, never "too old".
 */
export function versionRefusal(installed: string | undefined): Error & { code: string } {
  const check = checkCli("opencode", installed);
  if (check.status === "too_old")
    return new CliTooOldError("opencode", check.installed, check.required);
  const message =
    check.status === "unreadable"
      ? `OpenCode's version is unknown; ace supports ${supportedRange}`
      : `OpenCode ${check.installed} is newer than ace has checked; ace supports ${supportedRange}`;
  return Object.assign(new Error(message), { code: "cli_unsupported" });
}

const HttpMethods = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);

const Spec = z
  .object({
    openapi: z.string().startsWith("3."),
    paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .passthrough();

const Operation = z.object({ operationId: z.string() }).passthrough();

/** Diagnostics treat `{...}` as structured data, so routes are shown as `:param`. */
function readable(route: string): string {
  return route.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Compare the server's OpenAPI document with the routes ace calls. Unknown
 * operations, fields and extensions are ignored; only missing or moved required
 * operations count as a different contract.
 */
export function contractDifferences(value: unknown): string[] {
  const spec = Spec.parse(value);
  const served = new Map<string, string[]>();
  for (const [route, methods] of Object.entries(spec.paths))
    for (const [method, entry] of Object.entries(methods)) {
      if (!HttpMethods.has(method)) continue;
      const operation = Operation.safeParse(entry);
      if (!operation.success) continue;
      const routes = served.get(operation.data.operationId) ?? [];
      routes.push(`${method.toUpperCase()} ${route}`);
      served.set(operation.data.operationId, routes);
    }
  const differences: string[] = [];
  for (const [operationId, expected] of Object.entries(requiredRoutes)) {
    const routes = served.get(operationId);
    if (!routes) differences.push(`${operationId} is missing`);
    else if (!routes.includes(expected))
      differences.push(
        `${operationId} moved from ${readable(expected)} to ${routes.map(readable).join(", ")}`,
      );
  }
  return differences;
}

/** Throws a readable reason when the served contract differs from the one ace drives. */
export function validateSpec(value: unknown, installed: string): void {
  const differences = contractDifferences(value);
  if (differences.length)
    throw Object.assign(
      new Error(
        `OpenCode ${installed} changed the API ace uses (${differences.join("; ")}); ace supports ${supportedRange} with the ${minimumVersion} API`,
      ),
      { code: "cli_unsupported" },
    );
}

/** An OpenAPI document serving `routes`, for local boundary doubles of `opencode serve`. */
export function openApiDocument(routes: Readonly<Record<string, string>> = requiredRoutes): {
  openapi: string;
  paths: Record<string, Record<string, { operationId: string }>>;
} {
  const paths: Record<string, Record<string, { operationId: string }>> = {};
  for (const [operationId, route] of Object.entries(routes)) {
    const [method = "GET", path = "/"] = route.split(" ");
    (paths[path] ??= {})[method.toLowerCase()] = { operationId };
  }
  return { openapi: "3.1.0", paths };
}
