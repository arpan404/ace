import { z } from "zod";
import type { JsonPath, UsageMapping, WindowMapping } from "./declaration.ts";

/*
 * Pure: a usage answer mapped by its declaration to ace's provider-neutral reading
 * (`usageWindows`, percent used, epoch-ms reset). Lenient: an entry that doesn't fit is left
 * out, never guessed, and an answer with no windows is no reading at all.
 */

type Neutral = {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins?: number;
  /** Shown, but never holds the account at its limit (`UsageMapping.holds`). */
  advisory?: true;
};

const container = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const record = (value: unknown) => container.safeParse(value).data;

/** Every value at `path`, with the key of the last `*` it passed through. */
function select(root: unknown, path: JsonPath): { key: string | undefined; value: unknown }[] {
  let current: { key: string | undefined; value: unknown }[] = [{ key: undefined, value: root }];
  for (const step of path) {
    const next: typeof current = [];
    for (const { key, value } of current) {
      if (step === "*") {
        if (Array.isArray(value))
          value
            .slice(0, 64)
            .forEach((entry, index) => next.push({ key: String(index), value: entry }));
        else {
          const map = record(value);
          if (map)
            for (const name of Object.keys(map).slice(0, 64))
              next.push({ key: name, value: map[name] });
        }
      } else if (typeof step === "number") {
        if (Array.isArray(value) && step < value.length) next.push({ key, value: value[step] });
      } else {
        const map = record(value);
        if (map && Object.hasOwn(map, step)) next.push({ key, value: map[step] });
      }
    }
    current = next;
  }
  return current;
}
/** The first value at `path`, if any. */
export const first = (root: unknown, path: JsonPath | undefined) =>
  path ? select(root, path)[0]?.value : undefined;
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;

/** An instant in epoch milliseconds, or undefined when it doesn't read as one. */
export function instant(value: unknown, unit: "s" | "ms" | "iso"): number | undefined {
  if (unit === "iso") {
    if (typeof value !== "string") return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const n = finite(value);
  if (n === undefined || n < 0) return undefined;
  return unit === "s" ? n * 1000 : n;
}

function window(entry: unknown, root: unknown, mapping: WindowMapping): Neutral | undefined {
  const raw = finite(first(entry, mapping.amount.path));
  if (raw === undefined || raw < 0) return undefined;
  const percent =
    mapping.amount.scale === "percent"
      ? raw
      : mapping.amount.scale === "fraction"
        ? raw * 100
        : mapping.amount.scale === "remainingPercent"
          ? 100 - raw
          : 100 - raw * 100;
  if (percent < 0 || percent > 100.5) return undefined;
  const resets = mapping.resetsAt;
  const resetsAt = resets
    ? (instant(first(resets.fromRoot ? root : entry, resets.path), resets.unit) ?? null)
    : null;
  const named = mapping.durationByName;
  const byName = named ? first(entry, named.path) : undefined;
  const duration =
    finite(first(entry, mapping.windowDurationMins)) ??
    (named && typeof byName === "string" && Object.hasOwn(named.minutes, byName)
      ? named.minutes[byName]
      : undefined) ??
    mapping.durationMins;
  return {
    usedPercent: Math.min(100, Math.max(0, percent)),
    resetsAt,
    ...(duration !== undefined && duration > 0 ? { windowDurationMins: duration } : {}),
  };
}

/** A plan name the answer gives, or "" when it gives none that reads as one. */
export function planName(value: unknown): string {
  return typeof value === "string" && value.trim() && value.length <= 128 ? value.trim() : "";
}

/**
 * A mapping's window entries, each with its group's name when the windows are grouped: "" for a
 * group without a usable name, so its windows are left out rather than merged under another's.
 */
function entries(answer: unknown, mapping: WindowMapping) {
  const grouping = mapping.group;
  if (!grouping) return [{ group: undefined, found: select(answer, mapping.each) }];
  return select(answer, grouping.each).map(({ value }) => {
    const named = first(value, grouping.name);
    return {
      group: typeof named === "string" ? named.trim() : "",
      found: select(value, mapping.each),
    };
  });
}

export type UsageReading = { usageWindows?: Record<string, Neutral>; planType?: string };

/** The reading, or undefined when the answer has neither a window nor a plan it recognises. */
export function mapUsage(answer: unknown, mapping: UsageMapping): UsageReading | undefined {
  if (mapping.expect.some(({ path, equals }) => first(answer, path) !== equals)) return undefined;
  const usageWindows: Record<string, Neutral> = {};
  for (const declared of mapping.windows)
    for (const { group, found } of entries(answer, declared))
      for (const { key, value } of found) {
        const named = first(value, declared.name);
        const own =
          declared.label ?? (typeof named === "string" && named.trim() ? named.trim() : key);
        const name = group === undefined ? own : group && own && `${group} · ${own}`;
        const reading = window(value, answer, declared);
        if (!name || !reading || name.length > 128) continue;
        if (Object.keys(usageWindows).length >= 32) break;
        usageWindows[name] = mapping.holds ? reading : { ...reading, advisory: true };
      }
  const planType = planName(first(answer, mapping.plan));
  if (!Object.keys(usageWindows).length && !planType) return undefined;
  return {
    ...(Object.keys(usageWindows).length ? { usageWindows } : {}),
    ...(planType ? { planType } : {}),
  };
}
