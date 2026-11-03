import { UsageQuery, type UsageDimension, type UsageRow } from "@ace/protocol";
import { usageDay } from "@ace/ui-core";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";
import { profileStats, shares, type ProfileStats, type Share } from "./stats.ts";

/** Provider accounts ranked by tokens, the top four, each with its share of all of them. */
function accountShares(
  rows: readonly { provider: string; account: string; tokens: number }[],
): AccountShare[] {
  const byKey = new Map(rows.map((row) => [`${row.provider}\n${row.account}`, row]));
  return shares(
    rows
      .filter((row) => row.provider)
      .map((row) => ({
        key: `${row.provider}\n${row.account}`,
        tokens: row.tokens,
      })),
    4,
  ).map((share) =>
    Object.assign(share, {
      provider: byKey.get(share.key)?.provider ?? "",
      account: byKey.get(share.key)?.account ?? "",
    }),
  );
}

/** Tokens a row spent: what went in and what came out, as the rail's Usage bars count them. */
const spent = (row: UsageRow) => row.totals.inputTokens + row.totals.outputTokens;

/** A provider account's share: `key` is the provider and account together. */
export interface AccountShare extends Share {
  provider: string;
  /** The account's id; empty for usage recorded before accounts were. */
  account: string;
}

export interface ProfileActivity {
  stats: ProfileStats;
  /** The most used provider accounts, each on its own. */
  providers: AccountShare[];
  models: Share[];
  skills: { used: number; top: Share | undefined };
  /** Percent of tokens subagents and child threads spent. */
  delegatedPercent: number;
  /** Until the first read answers. */
  loading: boolean;
}

/**
 * A year of this computer's agent work, from the daemon's usage records: per day, provider,
 * model, skill and role. Read once per visit and kept for a minute; nothing polls.
 */
export function useProfileActivity(): ProfileActivity {
  const now = useNow();
  const zone = useUsageTimeZone();
  const today = usageDay(now, zone.timeZone);
  const from = usageDay(now, zone.timeZone, 364);
  const query = useDaemonQuery({
    queryKey: ["profile", "activity", from, today],
    enabled: zone.ready,
    staleTime: 60_000,
    read: async (client, signal) => {
      const summary = async (groupBy: UsageDimension[], limit: number) => {
        const usage = UsageQuery.parse({ from, to: today, groupBy, limit });
        return (await client.request({ type: "usage.summary", query: usage }, { signal })).result
          .rows;
      };
      const read = async (groupBy: UsageDimension, limit: number) =>
        (await summary([groupBy], limit)).map((row) => ({
          key: row.dimensions[groupBy] ?? "",
          tokens: spent(row),
        }));
      const accounts = async () =>
        (await summary(["provider", "account"], 100)).map((row) => ({
          provider: row.dimensions.provider ?? "",
          account: row.dimensions.account ?? "",
          tokens: spent(row),
        }));
      // An older daemon that doesn't group by skill or role leaves those insights out.
      const optional = (groupBy: UsageDimension, limit: number) =>
        read(groupBy, limit).catch(() => []);
      const [days, providers, models, skills, roles] = await Promise.all([
        read("day", 400),
        accounts(),
        read("model", 50),
        optional("skill", 500),
        optional("role", 10),
      ]);
      return { days, providers, models, skills, roles };
    },
  });
  const data = query.data;
  return useMemo(() => {
    const days = (data?.days ?? []).map((row) => ({ day: row.key, tokens: row.tokens }));
    const skillRows = (data?.skills ?? []).filter((row) => row.key && row.tokens > 0);
    const roles = data?.roles ?? [];
    const roleTotal = roles.reduce((sum, row) => sum + row.tokens, 0);
    const delegated = roles
      .filter((row) => row.key === "subagent" || row.key === "delegated")
      .reduce((sum, row) => sum + row.tokens, 0);
    return {
      stats: profileStats(days, today),
      providers: accountShares(data?.providers ?? []),
      models: shares(
        (data?.models ?? []).filter((row) => row.key),
        3,
      ),
      skills: { used: skillRows.length, top: shares(skillRows, 1)[0] },
      delegatedPercent: roleTotal > 0 ? Math.round((delegated / roleTotal) * 100) : 0,
      loading: !data,
    };
  }, [data, today]);
}
