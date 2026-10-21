import type { ClientApi } from "@ace/client";
import { SourceControlPreferences, WorkspaceId, type SourceControlReadiness } from "@ace/protocol";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { daemonErrorCode } from "./daemon-command.ts";
import { subscribeSettings } from "./settings-subscription.ts";

/**
 * Drop account-dependent data and cancel old reads before asking the affected daemon again:
 * thread PR reads, the PR panel's forge reads and the GitHub readiness and repository lists.
 */
export async function refreshSourceControl(queries: QueryClient, client: ClientApi): Promise<void> {
  const predicate = (query: Query) => {
    const [owner, resource] = query.queryKey;
    return (
      query.meta?.daemonClient === client &&
      ((owner === "thread" && (resource === "pr" || resource === "details")) ||
        owner === "forge" ||
        (owner === "projects" &&
          (resource === "github-readiness" || resource === "github-repositories")))
    );
  };
  await queries.cancelQueries({ predicate });
  await queries.resetQueries({ predicate });
}

/** A preferences change drops account-dependent reads; other pushes and reconnects keep them. */
export function useSourceControlCache(client: ClientApi): void {
  const queries = useQueryClient();
  useEffect(() => {
    let last: string | undefined;
    const subscription = subscribeSettings(
      client,
      ["sourceControl.preferences"],
      {},
      (entries) => {
        const entry = entries.find((candidate) => candidate.key === "sourceControl.preferences");
        if (!entry) return;
        const parsed = SourceControlPreferences.safeParse(entry.value);
        if (!parsed.success) return;
        const current = JSON.stringify(parsed.data);
        if (last === undefined) {
          last = current;
          return;
        }
        if (current !== last) {
          last = current;
          void refreshSourceControl(queries, client);
        }
      },
      () => {},
    );
    return () => subscription.stop();
  }, [client, queries]);
}

/** A read the daemon refused, keeping its code for `actionErrorText`. */
export class SourceControlReadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "SourceControlReadError";
    this.code = code;
  }
}

/** The code behind a failed read: the daemon's refusal or the client's own (offline...). */
export function readFailureCode(error: unknown): string | undefined {
  if (error instanceof SourceControlReadError) return error.code;
  const code = daemonErrorCode(error);
  return code === "unknown" ? undefined : code;
}

/** The selected daemon's GitHub CLI and API sign-in, optionally checking a project's remote. */
export async function readReadiness(
  client: ClientApi,
  workspaceId: string | undefined,
  signal: AbortSignal,
): Promise<SourceControlReadiness> {
  const reply = await client.request(
    {
      type: "source-control.request",
      operation: {
        op: "readiness",
        ...(workspaceId ? { workspaceId: WorkspaceId.parse(workspaceId) } : {}),
      },
    },
    { signal },
  );
  if (reply.result.kind === "error") throw new SourceControlReadError(reply.result.code);
  return reply.result.readiness;
}

/** The API sign-in state in a few words, naming both accounts when they differ. */
export function apiState(status: SourceControlReadiness): string {
  const expected = status.preferences.hosts.find(
    (entry) => entry.host === status.preferences.host,
  )?.account;
  if (status.api === "ready") return `Signed in as ${status.account ?? "unknown"}`;
  if (status.api === "account_mismatch")
    return `Signed in as ${status.account ?? "no account"}, expected ${expected ?? "another account"}`;
  if (status.api === "login_required") return "Not signed in";
  // Network and quota answers, never a sign-in problem.
  if (status.api === "offline") return "GitHub unreachable";
  if (status.api === "rate_limited") return "GitHub rate limit reached";
  return status.cli === "available" ? "GitHub API unavailable" : "GitHub CLI not installed";
}
