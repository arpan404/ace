import { UsageQuery, type UsageDimension, type UsageRow } from "@ace/protocol";
import { profileActivity, usageDay, type ProfileActivity as Activity } from "@ace/ui-core";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";

export type { AccountShare } from "@ace/ui-core";

/** Tokens a row spent: what went in and what came out, as the rail's Usage bars count them. */
const spent = (row: UsageRow) => row.totals.inputTokens + row.totals.outputTokens;

export interface ProfileActivity extends Activity {
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
  return useMemo(
    () => ({
      ...profileActivity(
        data
          ? [
              {
                days: data.days,
                providers: data.providers,
                models: data.models,
                skills: data.skills,
                roles: data.roles,
              },
            ]
          : [],
        today,
      ),
      loading: !data,
    }),
    [data, today],
  );
}
