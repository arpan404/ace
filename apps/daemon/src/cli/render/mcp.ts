import type { OutsideAccessRequest, OutsideGrantEntry } from "@ace/protocol";
import { formatAge, formatAgo } from "@ace/ui-core/time";
import { columns } from "./provider-columns.ts";

/** `ace mcp …` for a person: grants, a new grant's setup, and sign-in requests. Pure. */

function live(grant: OutsideGrantEntry, now: number): boolean {
  return grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > now);
}

function scopeWords(scopes: readonly string[]): string {
  return scopes.map((scope) => scope.replace("threads:", "")).join(", ");
}

export function mcpListLines(
  value: { url: string; grants: readonly OutsideGrantEntry[] },
  now: number,
): string[] {
  const current = value.grants.filter((grant) => live(grant, now));
  const ended = value.grants.length - current.length;
  const rows = current.map((grant) => [
    grant.id,
    grant.name,
    scopeWords(grant.scopes),
    grant.expiresAt === null ? "until revoked" : `ends in ${formatAge(now, grant.expiresAt)}`,
    grant.lastUsedAt === null ? "never used" : `used ${formatAgo(grant.lastUsedAt, now)}`,
  ]);
  return [
    `Outside clients connect to ${value.url}`,
    ...(rows.length
      ? ["", ...columns(rows)]
      : ["No clients have access. Add one with ace mcp add."]),
    ...(ended ? ["", `${ended} ended. --json lists them.`] : []),
  ];
}

export function grantIds(value: { grants: readonly OutsideGrantEntry[] }, now: number): string[] {
  return value.grants.filter((grant) => live(grant, now)).map((grant) => grant.id);
}

export function mcpAddedLines(data: {
  id: string;
  expiresAt: number | null;
  setup: string;
  claude: string;
  codex: string;
}): string[] {
  return [
    `Grant ${data.id}, ${data.expiresAt === null ? "until revoked" : `ends ${new Date(data.expiresAt).toISOString()}`}.`,
    "",
    data.setup,
    "",
    data.claude,
    "",
    "# ~/.codex/config.toml",
    data.codex,
  ];
}

export function mcpRequestLines(
  value: { requests: readonly OutsideAccessRequest[] },
  now: number,
): string[] {
  if (!value.requests.length) return ["No clients are asking to sign in."];
  return [
    ...columns(
      value.requests.map((request) => [
        request.requestId,
        request.clientName,
        request.domain ?? "unverified",
        `code ${request.matchCode}`,
        scopeWords(request.scopes),
        `ends in ${formatAge(now, request.expiresAt)}`,
      ]),
    ),
    "",
    "Check the code matches the one the client shows, then ace mcp request allow REQUEST.",
    ...(value.requests.some((request) => request.redirectKind === "this-device")
      ? [
          "A request sent back to an app on its own device can't be vouched for; allow only your own.",
        ]
      : []),
  ];
}
