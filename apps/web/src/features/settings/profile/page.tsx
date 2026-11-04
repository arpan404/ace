import { ProviderKind } from "@ace/protocol";
import { formatTokens, modelLabel, providerNames } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useAccountMachines } from "@/features/ace-account/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { useMachines, usePrimaryMachine } from "@/lib/machines.ts";
import { useProviderAccountModels } from "@/lib/account-views.ts";
import { MachineAccount } from "../machine-account.tsx";
import { settingRow } from "../settings-index.ts";
import { ProfileHero, useProfileAccount } from "./account.tsx";
import { ActivityGrid } from "./activity-grid.tsx";
import { Legal, NameSetting } from "./you.tsx";
import { useProfileActivity, type AccountShare, type ProfileActivity } from "./use-stats.ts";

const shortDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);

/**
 * Profile: the person, a year of their agents' work on this computer (the headline numbers,
 * a day-by-day grid, the providers they lean on and a few insights), then their ace account,
 * this computer's place on it and the name ace shows beside their messages.
 */
export function ProfilePage() {
  const account = useProfileAccount();
  const activity = useProfileActivity();
  return (
    <Screen
      title="Profile"
      namedByPanel
      actions={
        account.session ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={account.busy || account.restoring}
            onClick={() => void account.signOut()}
          >
            Sign out
          </Button>
        ) : undefined
      }
    >
      <div className="h-full overflow-auto">
        <div className="@container mx-auto flex w-full max-w-[52rem] flex-col gap-12 px-5 pt-12 pb-20 sm:px-8">
          <ProfileHero account={account} />
          <Highlights activity={activity} />
          <Section
            title="Activity"
            trailing={
              <span className="text-sm text-subtle-foreground">This computer · last 12 months</span>
            }
          >
            <ActivityGrid stats={activity.stats} />
            {!activity.loading && activity.stats.total === 0 && (
              <p className="mt-3 text-ui text-muted-foreground">
                Your agents' work shows here as they run.
              </p>
            )}
          </Section>
          {activity.providers.length > 0 && (
            <Section title="Most used providers">
              <ProviderTiles shares={activity.providers} />
            </Section>
          )}
          <Insights activity={activity} />
          <AccountSection signedIn={Boolean(account.session)} />
          <Legal />
        </div>
      </div>
    </Screen>
  );
}

function Section(props: { title: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={props.title}>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h3 className="text-base font-medium">{props.title}</h3>
        {props.trailing}
      </div>
      {props.children}
    </section>
  );
}

/** Five numbers across, in one hairline-framed band; two or three to a row on a narrow page. */
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
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border @lg:grid-cols-3 @2xl:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex flex-col-reverse items-center gap-1 bg-background px-3 py-4"
        >
          <dt className="text-center text-sm text-muted-foreground">{item.label}</dt>
          <dd className="text-base font-medium tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Each of the most used provider accounts: its mark, provider, account and share. */
function ProviderTiles(props: { shares: readonly AccountShare[] }) {
  const accounts = useProviderAccountModels().accounts.data;
  const names = new Map((accounts ?? []).map((account) => [account.id, account.label]));
  return (
    <ul className="flex flex-wrap gap-4">
      {props.shares.map((share) => {
        const kind = ProviderKind.safeParse(share.provider);
        const provider = kind.success ? providerNames[kind.data] : share.provider;
        // Usage from before accounts were recorded, or from an account since removed.
        const account = names.get(share.account) ?? (share.account ? "Removed account" : "");
        return (
          <li
            key={share.key}
            aria-label={`${provider}${account ? `, ${account}` : ""}, ${share.percent}%`}
            className="flex w-28 flex-col items-center gap-2 text-center"
          >
            <span className="grid size-14 place-items-center rounded-2xl bg-secondary shadow-[inset_0_0_0_1px_var(--border)]">
              {kind.success ? (
                <ProviderIcon provider={kind.data} size={24} decorative />
              ) : (
                <span aria-hidden className="text-base font-medium">
                  {provider.slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            <span aria-hidden className="flex w-full flex-col">
              <span className="truncate text-sm">{provider}</span>
              {account && <span className="truncate text-xs text-muted-foreground">{account}</span>}
              <span className="mt-0.5 text-xs text-subtle-foreground tabular-nums">
                {share.percent}%
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Insights(props: { activity: ProfileActivity }) {
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
    <Section title="Insights">
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-6 py-2.5">
            <dt className="text-ui text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 truncate text-ui tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/** "3 machines", "1 machine". */
const machineCount = (count: number) => (count === 1 ? "1 machine" : `${count} machines`);

/** The ace account's machines and this computer on it, then the person's name. */
function AccountSection(props: { signedIn: boolean }) {
  return (
    <div className="flex flex-col">
      {props.signedIn && <AccountMachines />}
      <NameSetting />
    </div>
  );
}

function AccountMachines() {
  const primary = usePrimaryMachine();
  const machines = useMachines();
  const account = useAccountMachines(machines);
  const names = [
    ...machines.filter((machine) => account.alsoOnAccount.has(machine.id)).map((m) => m.name),
    ...account.only.map((machine) => machine.name),
  ];
  return (
    <>
      <MachineAccount machine={primary} label="This computer" />
      <SettingSection label="Machines on your account" card>
        <SettingRow
          {...settingRow("profile.machines")}
          title={names.length ? machineCount(names.length) : "No machines yet"}
          description={
            names.length
              ? names.join(", ")
              : "Sign a computer in to your account to open it from your other devices."
          }
          inline
        >
          <Button size="sm" variant="ghost" render={<Link to="/settings/remote" />}>
            Open Fleet
          </Button>
        </SettingRow>
        {account.error && (
          <SettingNote role="alert">
            Couldn't load your account's machines. Try again later.
          </SettingNote>
        )}
      </SettingSection>
    </>
  );
}
