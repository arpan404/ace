import { ProviderKind } from "@ace/protocol";
import { formatTokens, modelLabel, providerNames } from "@ace/ui-core";
import {
  SettingList,
  SettingListItem,
  SettingNote,
  SettingSection,
} from "@/components/setting-row.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useProviderAccountModels } from "@/lib/account-views.ts";
import { ActivityGrid } from "./activity-grid.tsx";
import type { AccountShare, ProfileActivity } from "./use-stats.ts";

const shortDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);

/**
 * A year of this computer's agents: the headline numbers as one line of facts, then the
 * day-by-day grid, under the group's title like any settings group.
 */
export function ActivitySection(props: { activity: ProfileActivity }) {
  const { stats, loading } = props.activity;
  return (
    <SettingSection label="Activity" note="This computer · last 12 months">
      <Highlights activity={props.activity} />
      <div data-setting-slot="" className="py-4">
        <ActivityGrid stats={stats} />
      </div>
      {!loading && stats.total === 0 && (
        <SettingNote>Your agents' work shows here as they run.</SettingNote>
      )}
    </SettingSection>
  );
}

/** The five headline numbers on one wrapping line: muted words, values in foreground figures. */
function Highlights(props: { activity: ProfileActivity }) {
  const { stats, loading } = props.activity;
  const value = (shown: string) => (loading ? "–" : shown);
  const items = [
    { label: "Tokens this year", value: value(formatTokens(stats.total)) },
    {
      label: stats.peak
        ? `Busiest day · ${shortDay.format(Date.parse(`${stats.peak.day}T00:00:00Z`))}`
        : "Busiest day",
      value: value(stats.peak ? formatTokens(stats.peak.tokens) : "0"),
    },
    { label: "Active days", value: value(String(stats.activeDays)) },
    { label: "Longest streak", value: value(days(stats.longestStreak)) },
    { label: "Current streak", value: value(days(stats.currentStreak)) },
  ];
  return (
    <dl
      data-setting-slot=""
      className="flex flex-wrap gap-x-5 gap-y-1 py-3 text-ui text-muted-foreground"
    >
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <dt>{item.label}</dt>
          <dd className="text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Each of the most used provider accounts as a row: its mark, provider, account and share. */
export function ProvidersSection(props: { shares: readonly AccountShare[] }) {
  const accounts = useProviderAccountModels().accounts.data;
  const names = new Map((accounts ?? []).map((account) => [account.id, account.label]));
  if (!props.shares.length) return null;
  return (
    <SettingSection label="Most used providers">
      <SettingList className="divide-y divide-border-soft">
        {props.shares.map((share) => {
          const kind = ProviderKind.safeParse(share.provider);
          const provider = kind.success ? providerNames[kind.data] : share.provider;
          // Usage from before accounts were recorded, or from an account since removed.
          const account = names.get(share.account) ?? (share.account ? "Removed account" : "");
          return (
            <SettingListItem
              key={share.key}
              aria-label={`${provider}${account ? `, ${account}` : ""}, ${share.percent}%`}
              className="gap-3 text-ui"
            >
              <span aria-hidden className="grid size-4 shrink-0 place-items-center">
                {kind.success ? (
                  <ProviderIcon provider={kind.data} size={16} decorative />
                ) : (
                  <span className="text-xs font-medium">{provider.slice(0, 1).toUpperCase()}</span>
                )}
              </span>
              <span aria-hidden className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate text-foreground">{provider}</span>
                {account && <span className="truncate text-muted-foreground">{account}</span>}
              </span>
              <span aria-hidden className="shrink-0 text-foreground tabular-nums">
                {share.percent}%
              </span>
            </SettingListItem>
          );
        })}
      </SettingList>
    </SettingSection>
  );
}

/** The most used model and skill, skills used and the share subagents did, as label–value rows. */
export function InsightsSection(props: { activity: ProfileActivity }) {
  const { models, skills, delegatedPercent, stats } = props.activity;
  const top = models[0];
  const rows = [
    top && { label: "Most used model", value: `${modelLabel(top.key)} · ${top.percent}%` },
    skills.used > 0 && { label: "Skills used", value: String(skills.used) },
    skills.top && { label: "Most used skill", value: skills.top.key },
    stats.total > 0 && { label: "Work done by subagents", value: `${delegatedPercent}%` },
  ].filter((row): row is { label: string; value: string } => Boolean(row));
  if (!rows.length) return null;
  return (
    <SettingSection label="Insights">
      {rows.map((row) => (
        <dl
          key={row.label}
          data-setting-slot=""
          className="flex min-h-(--row-height) items-baseline justify-between gap-6 py-2.5"
        >
          <dt className="text-ui text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 truncate text-ui text-foreground tabular-nums">{row.value}</dd>
        </dl>
      ))}
    </SettingSection>
  );
}
