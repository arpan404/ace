import type { ClientCore } from "@ace/client";
import { ProviderKind, UsageQuery, type UsageDimension, type UsageRow } from "@ace/protocol";
import {
  formatTokens,
  knownTimeZone,
  modelLabel,
  profileActivity,
  providerNames,
  shares,
  usageCoverage,
  usageDay,
} from "@ace/ui-core";
import { z } from "zod";
import { host } from "./host.ts";
import { UsageMachineReach } from "./usage-report.ts";

/*
 * The profile's year of work on the phone, as the web's Profile page counts it, over every
 * machine in scope. Each machine reads its part (`profile.part`, its rows by day, provider and
 * account, model, skill and role) and Swift hands the parts to `profile.combine`, which adds them
 * up with the web's `profileActivity` and words the figures. Swift only routes.
 */

const Day = z.iso.date();
const Keyed = z.array(z.object({ key: z.string().max(512), tokens: z.number().nonnegative() }));
const Part = z.object({
  type: z.literal("profile.part"),
  from: Day,
  to: Day,
  days: Keyed.max(400),
  providers: z
    .array(
      z.object({
        provider: z.string().max(64),
        account: z.string().max(256),
        tokens: z.number().nonnegative(),
      }),
    )
    .max(100),
  models: Keyed.max(50),
  skills: Keyed.max(500),
  roles: Keyed.max(10),
});
export const ProfilePart = Part;
export type ProfilePart = z.infer<typeof Part>;

export const ProfilePartRequest = z.object({ type: z.literal("profile.part") });
export const ProfileCombineRequest = z.object({
  type: z.literal("profile.combine"),
  machines: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        name: z.string().min(1).max(128),
        reach: UsageMachineReach,
        part: Part.optional(),
      }),
    )
    .min(1)
    .max(32),
});
export type ProfileCombineRequest = z.infer<typeof ProfileCombineRequest>;

export interface ProfileFigure {
  label: string;
  value: string;
}
export interface ProfileReport {
  type: "profile.report";
  /** "All 3 machines", "2 of 3 machines · Studio is offline"; null for one counted machine. */
  coverage: string | null;
  /** "Last 12 months". */
  span: string;
  /** No work counted anywhere yet. */
  empty: boolean;
  highlights: ProfileFigure[];
  /** One column per week, Sunday first: 0 for no work, 1–4 by quartile, -1 outside the year. */
  weeks: number[][];
  months: { label: string; week: number }[];
  providers: { name: string; percent: number }[];
  insights: ProfileFigure[];
}

const quiet = 15_000;
/** Tokens a row spent: what went in and what came out, as the web's profile counts them. */
const spent = (row: UsageRow) => row.totals.inputTokens + row.totals.outputTokens;
const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);
const shortDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const providerName = (id: string) => {
  const kind = ProviderKind.safeParse(id);
  return kind.success ? providerNames[kind.data] : id;
};

async function summary(
  owner: ClientCore,
  span: { from: string; to: string },
  groupBy: UsageDimension[],
  limit: number,
  signal: AbortSignal,
) {
  const query = UsageQuery.parse({ ...span, groupBy, limit });
  const reply = await owner.request(
    { type: "usage.summary", query, requestId: host.uuid() },
    { signal, timeoutMs: quiet },
  );
  return reply.result;
}

/** This machine's year, in its own usage time zone, grouped as the profile needs it. */
export async function readProfilePart(
  owner: ClientCore,
  signal: AbortSignal,
): Promise<ProfilePart> {
  const probe = await summary(owner, { from: "2026-01-01", to: "2026-01-01" }, [], 1, signal);
  const zone = knownTimeZone(probe.timezone);
  const now = host.now();
  const span = { from: usageDay(now, zone, 364), to: usageDay(now, zone) };
  const keyed = async (groupBy: UsageDimension, limit: number) =>
    (await summary(owner, span, [groupBy], limit, signal)).rows.map((row) => ({
      key: row.dimensions[groupBy] ?? "",
      tokens: spent(row),
    }));
  // An older daemon that doesn't group by skill or role leaves those insights out.
  const optional = (groupBy: UsageDimension, limit: number) =>
    keyed(groupBy, limit).catch(() => []);
  const [dayRows, accountRows, models, skills, roles] = await Promise.all([
    keyed("day", 400),
    summary(owner, span, ["provider", "account"], 100, signal),
    keyed("model", 50),
    optional("skill", 500),
    optional("role", 10),
  ]);
  return {
    type: "profile.part",
    ...span,
    days: dayRows,
    providers: accountRows.rows.map((row) => ({
      provider: row.dimensions.provider ?? "",
      account: row.dimensions.account ?? "",
      tokens: spent(row),
    })),
    models,
    skills,
    roles,
  };
}

/** Every counted machine's year, added up and worded as the web's profile words it. */
export function combineProfile(request: ProfileCombineRequest): ProfileReport {
  // Every machine counts up to its own today; the first counted one names the year shown.
  const counted = request.machines.filter((machine) => machine.reach === "counted" && machine.part);
  const today = counted[0]?.part?.to ?? "";
  const coverage = usageCoverage(
    request.machines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      reach: machine.reach === "counted" && !machine.part ? "failed" : machine.reach,
    })),
  );
  const parts = counted.flatMap((machine) => (machine.part ? [machine.part] : []));
  const activity = profileActivity(parts, today || "1970-01-01");
  const { stats } = activity;
  // The phone names providers, not their accounts: every account's tokens added up per
  // provider before ranking, so a provider used through many accounts reads whole.
  const providerRows = new Map<string, number>();
  for (const part of parts)
    for (const row of part.providers)
      if (row.provider)
        providerRows.set(row.provider, (providerRows.get(row.provider) ?? 0) + row.tokens);
  const providerShares = shares(
    [...providerRows].map(([key, tokens]) => ({ key, tokens })),
    4,
  );
  const top = activity.models[0];
  const insights = [
    top && { label: "Most used model", value: `${modelLabel(top.key)} · ${top.percent}%` },
    activity.skills.used > 0 && { label: "Skills used", value: String(activity.skills.used) },
    activity.skills.top && { label: "Most used skill", value: activity.skills.top.key },
    stats.total > 0 && {
      label: "Work done by subagents",
      value: `${activity.delegatedPercent}%`,
    },
  ].filter((row): row is ProfileFigure => Boolean(row));
  return {
    type: "profile.report",
    coverage: coverage.line,
    span: "Last 12 months",
    empty: stats.total === 0,
    highlights: [
      { label: "Tokens this year", value: formatTokens(stats.total) },
      {
        label: stats.peak
          ? `Busiest day · ${shortDay.format(Date.parse(`${stats.peak.day}T00:00:00Z`))}`
          : "Busiest day",
        value: stats.peak ? formatTokens(stats.peak.tokens) : "0",
      },
      { label: "Active days", value: String(stats.activeDays) },
      { label: "Longest streak", value: days(stats.longestStreak) },
      { label: "Current streak", value: days(stats.currentStreak) },
    ],
    weeks: today
      ? stats.weeks.map((week) => week.map((cell) => (cell.outside ? -1 : cell.level)))
      : [],
    months: today ? stats.months : [],
    providers: providerShares.map((share) => ({
      name: providerName(share.key),
      percent: share.percent,
    })),
    insights,
  };
}
