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
const first = (root: unknown, path: JsonPath | undefined) =>
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

function window(entry: unknown, mapping: WindowMapping): Neutral | undefined {
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
  const resetsAt = mapping.resetsAt
    ? (instant(first(entry, mapping.resetsAt.path), mapping.resetsAt.unit) ?? null)
    : null;
  const duration = finite(first(entry, mapping.windowDurationMins));
  return {
    usedPercent: Math.min(100, percent),
    resetsAt,
    ...(duration !== undefined && duration > 0 ? { windowDurationMins: duration } : {}),
  };
}

/** The reading, or undefined when the answer has no window the declaration recognises. */
export function mapUsage(
  answer: unknown,
  mapping: UsageMapping,
): { usageWindows: Record<string, Neutral>; planType?: string } | undefined {
  const usageWindows: Record<string, Neutral> = {};
  for (const declared of mapping.windows)
    for (const { key, value } of select(answer, declared.each)) {
      const named = first(value, declared.name);
      const name = typeof named === "string" && named.trim() ? named.trim() : key;
      const reading = window(value, declared);
      if (!name || !reading || name.length > 128) continue;
      if (Object.keys(usageWindows).length >= 32) break;
      usageWindows[name] = reading;
    }
  if (!Object.keys(usageWindows).length) return undefined;
  const plan = first(answer, mapping.plan);
  return {
    usageWindows,
    ...(typeof plan === "string" && plan.trim() && plan.length <= 128
      ? { planType: plan.trim() }
      : {}),
  };
}
