/*
 * The Usage page's reads, from every environment (connected daemon) shown: each one's accounts
 * and its usage rows over the range. Reads go to each environment's own client and never fall
 * back to another one. This window's daemon shares the app's `accounts.list` read, so a
 * provider's limit push updates the page live.
 */
import type { ClientApi } from "@ace/client";
import { UsageQuery, type UsageDimension, type UsageResult, type UsageRow } from "@ace/protocol";
import {
  accountView,
  previousSpan,
  usageCoverage,
  type AccountView,
  type EnvironmentUsage,
  type UsageCoverage,
  type UsageMachineReach,
} from "@ace/ui-core";
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

/** Whether a machine's read made it into the figures: offline, failed, loading or counted. */
function reach(
  environment: Machine,
  read: { data: unknown; error: Error | null },
): UsageMachineReach {
  if (!environment.client) return "offline";
  if (read.error && read.data === undefined) return "failed";
  return read.data === undefined ? "loading" : "counted";
}

/** Which machines the limits count, in the shared words. */
export function accountsCoverage(entries: readonly EnvironmentAccounts[]): UsageCoverage {
  return usageCoverage(
    entries.map((entry) => ({
      id: entry.environment.id,
      name: entry.environment.name,
      reach: reach(entry.environment, { data: entry.accounts, error: entry.error }),
    })),
  );
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
        const reply = await reachable(environment).request({ type: "accounts.list" }, { signal });
        return reply.accounts.map(accountView);
      },
    })),
  });
  return environments.map((environment, index) => {
    const read = environment.primary ? primary : others[index];
    return { environment, accounts: read?.data, error: read?.error ?? null };
  });
}

function reachable(environment: Machine): ClientApi {
  if (!environment.client) throw new Error(`${environment.name} is offline`);
  return environment.client;
}

/** The page's filters as usage queries take them: a dimension and its values. */
export type UsageFilters = Partial<Record<UsageDimension, string[]>>;

async function rows(
  client: ClientApi,
  kind: "summary" | "series",
  span: UsageSpan,
  groupBy: UsageDimension[],
  filters: UsageFilters,
  signal: AbortSignal,
  limit = 1000,
): Promise<UsageResult> {
  const query = UsageQuery.parse({
    from: span.from,
    to: span.to,
    groupBy,
    filters,
    equivalentApiCost: true,
    limit,
  });
  const type = kind === "series" ? "usage.series" : "usage.summary";
  return (await client.request({ type, query }, { signal })).result;
}

/** The "Where it went" lists each machine answers with its own query. */
export const breakdownDimensions = ["workspace", "account", "skill", "automation", "role"] as const;
export type BreakdownDimension = (typeof breakdownDimensions)[number];

/** One environment's usage over the span, and its days before, for growth. */
export interface EnvironmentRead {
  usage: EnvironmentUsage;
  /** The same number of days just before the span, per day and provider. */
  previous: readonly UsageRow[];
  /**
   * Rows per breakdown dimension; undefined for one this daemon can't group by (an older
   * daemon that doesn't record skills or automations), so the list says so instead of failing.
   */
  breakdowns: Partial<Record<BreakdownDimension, readonly UsageRow[]>>;
}

const breakdownLimit = 200;

/** One environment's usage over the span: per day and provider, per model, and each list. */
async function readUsage(
  client: ClientApi,
  span: UsageSpan,
  filters: UsageFilters,
  signal: AbortSignal,
): Promise<EnvironmentRead> {
  const before = { ...previousSpan(span.from, span.to), ready: span.ready };
  const lists = Promise.all(
    breakdownDimensions.map(async (dimension) => {
      try {
        const result = await rows(
          client,
          "summary",
          span,
          [dimension],
          filters,
          signal,
          breakdownLimit,
        );
        return [dimension, result.rows] as const;
      } catch (error) {
        if (signal.aborted) throw error;
        return [dimension, undefined] as const;
      }
    }),
  );
  const [daily, models, earlier, breakdowns] = await Promise.all([
    rows(client, "series", span, ["day", "provider"], filters, signal),
    rows(client, "summary", span, ["model", "provider"], filters, signal),
    rows(client, "series", before, ["day", "provider"], filters, signal),
    lists,
  ]);
  return {
    // The page shows no per-thread figures, so threads aren't read.
    usage: { daily: daily.rows, models: models.rows, threads: [], threadsTruncated: false },
    previous: earlier.rows,
    breakdowns: Object.fromEntries(breakdowns.filter((entry) => entry[1] !== undefined)),
  };
}

/**
 * Each environment's usage over the span, for the providers given (all when undefined), with
 * the period before for growth. Ready once every machine in scope has answered, failed or is
 * offline; `coverage` names each one that isn't counted.
 */
export function useEnvironmentUsage(
  environments: readonly Machine[],
  span: UsageSpan,
  filters: UsageFilters,
) {
  const reads = useQueries({
    queries: environments.map((environment) => ({
      queryKey: ["usage-page", environment.id, "usage", span.from, span.to, filters],
      enabled: span.ready && environment.client !== undefined,
      // A new filter or range keeps the last figures on screen until the new ones arrive.
      placeholderData: (previous: EnvironmentRead | undefined) => previous,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        readUsage(reachable(environment), span, filters, signal),
    })),
  });
  const reaches = environments.map((environment, index) => {
    const read = reads[index];
    return reach(environment, { data: read?.data, error: read?.error ?? null });
  });
  const coverage = usageCoverage(
    environments.map((environment, index) => ({
      id: environment.id,
      name: environment.name,
      reach: reaches[index] ?? "loading",
    })),
  );
  const counted = reads.flatMap((read, index) => {
    const environment = environments[index];
    return reaches[index] === "counted" && read.data && environment
      ? [{ ...read.data, environment }]
      : [];
  });
  const settled = !reaches.includes("loading");
  return {
    data: settled
      ? {
          current: counted.map((read) => read.usage),
          previous: counted.map((read): EnvironmentUsage => ({
            daily: read.previous,
            models: [],
            threads: [],
            threadsTruncated: false,
          })),
          machines: counted,
        }
      : undefined,
    coverage,
    // Nothing to show only when no machine could be read and at least one failed.
    error:
      settled && counted.length === 0 ? (reads.find((read) => read.error)?.error ?? null) : null,
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
        const reply = await reachable(environment).request({ type: "accounts.refreshLimits" });
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
