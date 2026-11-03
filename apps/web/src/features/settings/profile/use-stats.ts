import { UsageQuery, type UsageDimension, type UsageRow } from "@ace/protocol";
import { usageDay } from "@ace/ui-core";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";
import { profileStats, shares, type ProfileStats, type Share } from "./stats.ts";

/** Tokens a row spent: what went in and what came out, as the rail's Usage bars count them. */
const spent = (row: UsageRow) => row.totals.inputTokens + row.totals.outputTokens;

export interface ProfileActivity {
  stats: ProfileStats;
  providers: Share[];
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
      const read = async (groupBy: UsageDimension, limit: number) => {
        const usage = UsageQuery.parse({ from, to: today, groupBy: [groupBy], limit });
        const reply = await client.request({ type: "usage.summary", query: usage }, { signal });
        return reply.result.rows.map((row) => ({
          key: row.dimensions[groupBy] ?? "",
          tokens: spent(row),
        }));
      };
      // An older daemon that doesn't group by skill or role leaves those insights out.
      const optional = (groupBy: UsageDimension, limit: number) =>
        read(groupBy, limit).catch(() => []);
      const [days, providers, models, skills, roles] = await Promise.all([
        read("day", 400),
        read("provider", 50),
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
      providers: shares(
        (data?.providers ?? []).filter((row) => row.key),
        4,
      ),
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
