/*
 * The Usage page's reads, from every environment (connected daemon) shown: each one's accounts
 * and its usage rows over the range. Reads go to each environment's own client and never fall
 * back to another one. This window's daemon shares the app's `accounts.list` read, so a
 * provider's limit push updates the page live.
 */
import type { ClientApi } from "@ace/client";
import { UsageQuery, type UsageDimension, type UsageResult } from "@ace/protocol";
import { accountView, type AccountView, type EnvironmentUsage } from "@ace/ui-core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useProviderAccountModels } from "@/lib/account-views.ts";
import type { Machine } from "@/lib/machines.ts";

/** Inclusive calendar days in the daemon's zone, as usage queries take them. */
export interface UsageSpan {
  from: string;
  to: string;
  ready: boolean;
}

export interface EnvironmentAccounts {
  environment: Machine;
  accounts: readonly AccountView[] | undefined;
  error: Error | null;
}

const otherRefreshMs = 60_000;

/** Each environment's accounts; undefined for one still loading. */
export function useEnvironmentAccounts(environments: readonly Machine[]): EnvironmentAccounts[] {
  const primary = useProviderAccountModels().accounts;
  const others = useQueries({
    queries: environments.map((environment) => ({
      queryKey: ["usage-page", environment.id, "accounts"],
      enabled: !environment.primary && environment.client !== undefined,
      refetchInterval: otherRefreshMs,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const reply = await reach(environment).request({ type: "accounts.list" }, { signal });
        return reply.accounts.map(accountView);
      },
    })),
  });
  return environments.map((environment, index) => {
    const read = environment.primary ? primary : others[index];
    return { environment, accounts: read?.data, error: read?.error ?? null };
  });
}

function reach(environment: Machine): ClientApi {
  if (!environment.client) throw new Error(`${environment.name} is offline`);
  return environment.client;
}

async function rows(
  client: ClientApi,
  kind: "summary" | "series",
  span: UsageSpan,
  groupBy: UsageDimension[],
  providers: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<UsageResult> {
  const query = UsageQuery.parse({
    from: span.from,
    to: span.to,
    groupBy,
    filters: providers ? { provider: [...providers] } : {},
    equivalentApiCost: true,
    limit: 1000,
  });
  const type = kind === "series" ? "usage.series" : "usage.summary";
  return (await client.request({ type, query }, { signal })).result;
}

/** One environment's usage over the span: per day and provider, per model, per session. */
async function readUsage(
  client: ClientApi,
  span: UsageSpan,
  providers: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<EnvironmentUsage> {
  const [daily, models, threads] = await Promise.all([
    rows(client, "series", span, ["day", "provider"], providers, signal),
    rows(client, "summary", span, ["model", "provider"], providers, signal),
    rows(client, "summary", span, ["thread", "provider"], providers, signal),
  ]);
  return {
    daily: daily.rows,
    models: models.rows,
    threads: threads.rows,
    threadsTruncated: threads.truncated,
  };
}

/** Each environment's usage over the span, for the providers given (all when undefined). */
export function useEnvironmentUsage(
  environments: readonly Machine[],
  span: UsageSpan,
  providers: readonly string[] | undefined,
) {
  const reads = useQueries({
    queries: environments.map((environment) => ({
      queryKey: ["usage-page", environment.id, "usage", span.from, span.to, providers ?? null],
      enabled: span.ready && environment.client !== undefined,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        readUsage(reach(environment), span, providers, signal),
    })),
  });
  return {
    data: reads.every((read) => read.data !== undefined)
      ? reads.flatMap((read) => (read.data ? [read.data] : []))
      : undefined,
    error: reads.find((read) => read.error)?.error ?? null,
    retry: () => {
      for (const read of reads) if (read.isError) void read.refetch();
    },
  };
}

/** Read everything on the page again: accounts and usage, in every environment. */
export function useRefreshUsage(environments: readonly Machine[]) {
  const queries = useQueryClient();
  return async () => {
    // Each environment asks its CLIs for current limits (no model turn); a daemon that can't
    // still answers with the limits it last recorded.
    await Promise.allSettled(
      environments.map(async (environment) => {
        const reply = await reach(environment).request({ type: "accounts.refreshLimits" });
        queries.setQueryData(
          environment.primary ? ["accounts", "list"] : ["usage-page", environment.id, "accounts"],
          reply.accounts.map(accountView),
        );
      }),
    );
    await Promise.all([
      queries.invalidateQueries({ queryKey: ["accounts"] }),
      queries.invalidateQueries({ queryKey: ["usage-page"] }),
    ]);
  };
}
