import type { MarketTrendMovement } from "@ace/protocol/marketplace";
import { rankingTiers, tiered, type RankingTier } from "./ranking.ts";

/*
 * Discover's rankings (ADR 0173 §6, §15), pure: Trending this week, top publishers and New and
 * notable's order. Download counts are anonymous totals per hour or per day; nothing here knows
 * who fetched. Hours and days are counted from the Unix epoch.
 */

export const hourMs = 3_600_000;
export const dayMs = 24 * hourMs;

export const trendRules = {
  /** The week a score reads, in hours. */
  windowHours: 168,
  /** How far back an hour's own baseline reaches. */
  baselineHours: 168,
  /** An hour never caps below this many downloads. */
  hourFloor: 50,
  /** An hour caps at this many times the median of its baseline's non-empty hours. */
  medianFactor: 4,
  /** A day counts at most this many downloads. */
  dayCap: 5_000,
  halfLifeHours: 72,
  /** Capped downloads in the week an entry needs to trend. */
  minimum: 5,
  /** Rows Discover shows. */
  shown: 50,
} as const;

export interface HourCount {
  hour: number;
  count: number;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The most one hour counts: `max(50, 4 × the median of its non-empty hours before)`. */
export function hourCap(hour: number, hours: readonly HourCount[]): number {
  const before = hours
    .filter(
      (row) => row.count > 0 && row.hour < hour && row.hour >= hour - trendRules.baselineHours,
    )
    .map((row) => row.count);
  if (before.length === 0) return trendRules.hourFloor;
  return Math.max(trendRules.hourFloor, trendRules.medianFactor * median(before));
}

/** The week's hours up to `atHour` with both caps applied, oldest first. */
export function cappedWeek(hours: readonly HourCount[], atHour: number): HourCount[] {
  const week = hours
    .filter((row) => row.hour <= atHour && row.hour > atHour - trendRules.windowHours)
    .toSorted((a, b) => a.hour - b.hour);
  const dayLeft = new Map<number, number>();
  const capped: HourCount[] = [];
  for (const row of week) {
    const day = Math.floor(row.hour / 24);
    const left = dayLeft.get(day) ?? trendRules.dayCap;
    const count = Math.min(row.count, hourCap(row.hour, hours), left);
    dayLeft.set(day, left - count);
    if (count > 0) capped.push({ hour: row.hour, count });
  }
  return capped;
}

export interface TrendScore {
  /** Decayed, capped downloads with the tier's multiplier. */
  score: number;
  /** Capped downloads this week. */
  week: number;
}

/** An entry's trending score at `atHour`; undefined below the minimum. */
export function trendScore(
  hours: readonly HourCount[],
  tier: RankingTier | undefined,
  atHour: number,
): TrendScore | undefined {
  const capped = cappedWeek(hours, atHour);
  const week = capped.reduce((sum, row) => sum + row.count, 0);
  if (week < trendRules.minimum) return undefined;
  const decayed = capped.reduce(
    (sum, row) => sum + row.count * 0.5 ** ((atHour - row.hour) / trendRules.halfLifeHours),
    0,
  );
  return { score: tiered(decayed, tier), week };
}

export interface ScoredEntry {
  key: string;
  /** This week's score; 0 when it trended only the week before. */
  score: number;
  week: number;
  /** The same ranking's score a week earlier; 0 when it didn't trend then. */
  before: number;
}

export interface TrendRow {
  key: string;
  rank: number;
  score: number;
  week: number;
  movement: MarketTrendMovement;
}

const byScore = (a: { key: string; score: number }, b: { key: string; score: number }) =>
  b.score !== a.score ? b.score - a.score : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/** Ranks scored entries, each with its movement against its rank a week earlier. */
export function rankScores(entries: readonly ScoredEntry[]): TrendRow[] {
  const earlier = new Map(
    entries
      .filter((entry) => entry.before > 0)
      .map((entry) => ({ key: entry.key, score: entry.before }))
      .toSorted(byScore)
      .map((entry, index) => [entry.key, index + 1]),
  );
  return entries
    .filter((entry) => entry.score > 0)
    .toSorted(byScore)
    .map((entry, index) => {
      const rank = index + 1;
      const was = earlier.get(entry.key);
      const movement: MarketTrendMovement =
        was === undefined
          ? { kind: "new" }
          : was > rank
            ? { kind: "up", by: was - rank }
            : was < rank
              ? { kind: "down", by: rank - was }
              : { kind: "same" };
      return { key: entry.key, rank, score: entry.score, week: entry.week, movement };
    });
}

export interface TrendInput {
  key: string;
  tier?: RankingTier | undefined;
  hours: readonly HourCount[];
}

/**
 * One entry's scores this week and the week before, or undefined when it trended in neither.
 * An entry that qualified only last week keeps a place in last week's ranking (score 0 now), so
 * the others' movement is measured against the ranking as it really was.
 */
export function trendScores(
  hours: readonly HourCount[],
  tier: RankingTier | undefined,
  atHour: number,
): Omit<ScoredEntry, "key"> | undefined {
  const now = trendScore(hours, tier, atHour);
  const before = trendScore(hours, tier, atHour - trendRules.windowHours);
  if (!now && !before) return undefined;
  return { score: now?.score ?? 0, week: now?.week ?? 0, before: before?.score ?? 0 };
}

/** The whole ranking at `atHour`, as the cron builds it in batches. */
export function rankTrending(entries: readonly TrendInput[], atHour: number): TrendRow[] {
  return rankScores(
    entries.flatMap((entry) => {
      const scores = trendScores(entry.hours, entry.tier, atHour);
      return scores ? [{ key: entry.key, ...scores }] : [];
    }),
  );
}

/* ---------------------------------------------------------------- top publishers */

export interface DayCount {
  day: number;
  count: number;
}

export interface PublisherInput {
  id: string;
  handle: string;
  tier?: RankingTier | undefined;
  /** Each listed entry's downloads per day. */
  entries: readonly (readonly DayCount[])[];
}

export const topPublisherRules = { days: 30, shown: 12 } as const;

/** An entry's downloads over the 30 days up to `atDay`, each day capped. */
export function cappedMonth(days: readonly DayCount[], atDay: number): number {
  return days
    .filter((row) => row.day <= atDay && row.day > atDay - topPublisherRules.days)
    .reduce((sum, row) => sum + Math.min(row.count, trendRules.dayCap), 0);
}

export interface TopPublisher {
  id: string;
  rank: number;
  downloads: number;
  entries: number;
}

/** The publishers with the most capped downloads in 30 days, the tier's multiplier applied. */
export function topPublishers(
  publishers: readonly PublisherInput[],
  atDay: number,
): TopPublisher[] {
  return publishers
    .map((publisher) => {
      const downloads = publisher.entries.reduce((sum, days) => sum + cappedMonth(days, atDay), 0);
      return {
        publisher,
        downloads,
        score: tiered(downloads, publisher.tier),
      };
    })
    .filter((row) => row.downloads > 0)
    .toSorted((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.publisher.handle < b.publisher.handle
          ? -1
          : a.publisher.handle > b.publisher.handle
            ? 1
            : 0,
    )
    .slice(0, topPublisherRules.shown)
    .map((row, index) => ({
      id: row.publisher.id,
      rank: index + 1,
      downloads: row.downloads,
      entries: row.publisher.entries.length,
    }));
}

/* ---------------------------------------------------------------- New and notable */

export const freshRules = { days: 30, shown: 24 } as const;

/**
 * New and notable's order: newest first by the day it was first listed, the tier breaking ties
 * within a day, then the exact time and the key.
 */
export function freshOrder<T extends { key: string; firstListed: number; tier?: RankingTier }>(
  entries: readonly T[],
  now: number,
): T[] {
  const tierWeight = (entry: T) => rankingTiers[entry.tier ?? "other"];
  return entries
    .filter(
      (entry) => entry.firstListed <= now && entry.firstListed > now - freshRules.days * dayMs,
    )
    .toSorted((a, b) => {
      const [dayA, dayB] = [Math.floor(a.firstListed / dayMs), Math.floor(b.firstListed / dayMs)];
      if (dayA !== dayB) return dayB - dayA;
      if (tierWeight(a) !== tierWeight(b)) return tierWeight(b) - tierWeight(a);
      if (a.firstListed !== b.firstListed) return b.firstListed - a.firstListed;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .slice(0, freshRules.shown);
}
