import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * What bots spent and the model review (ADR 0135, spade/docs/oversight.md), as Spade's API sends
 * them. Money is in micros, millionths of a US dollar. Spend is information only: Spade has no
 * spending limits (ADR 0166), so caps an older Spade still sends are not read. Parsed leniently:
 * a field this client can't read falls back to "not set", and every value keeps what it came
 * with in `raw`.
 */

/** A bot's spend so far. */
export interface SpadeSpending {
  todayMicros: number;
  monthMicros: number;
}

/** The service's oversight: the person's zone, every bot's spend, and the review default. */
export interface SpadeOversight {
  timeZone: string;
  todayMicros: number;
  monthMicros: number;
  reviewDefault: boolean;
  /** `endpoint/model`; undefined uses the fast model, else each bot's own. */
  reviewModel: string | undefined;
  raw: Record<string, unknown>;
}

const micros = z.number().nonnegative();
const spendingShape = z.object({
  today_micros: micros.catch(0).default(0),
  month_micros: micros.catch(0).default(0),
});

/** A Spending value; undefined when it isn't an object. */
export function parseSpadeSpending(raw: unknown): SpadeSpending | undefined {
  const parsed = spendingShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return {
    todayMicros: value.today_micros,
    monthMicros: value.month_micros,
  };
}

/** A bot's own review switch: on, off, or undefined to follow the default. */
export function parseSpadeReview(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

const oversightShape = z.object({
  time_zone: z.string().catch(""),
  today_micros: micros.catch(0).default(0),
  month_micros: micros.catch(0).default(0),
  review_default: z.boolean().catch(false).default(false),
  review_model: z.string().nullish().catch(undefined),
});

/** `{"oversight": …}`; undefined when the body has none. */
export function parseSpadeOversight(body: string): SpadeOversight | undefined {
  const raw = spadeRecord(spadeRecord(spadeJson(body))?.oversight);
  const parsed = oversightShape.safeParse(raw);
  if (!raw || !parsed.success) return undefined;
  const value = parsed.data;
  return {
    timeZone: value.time_zone,
    todayMicros: value.today_micros,
    monthMicros: value.month_micros,
    reviewDefault: value.review_default,
    reviewModel: value.review_model || undefined,
    raw,
  };
}

/** `{"spending", "review"}` from a bot's oversight routes; undefined without its spending. */
export function parseSpadeAgentOversight(
  body: string,
): { spending: SpadeSpending; review: boolean | undefined } | undefined {
  const record = spadeRecord(spadeJson(body));
  const spending = parseSpadeSpending(record?.spending);
  return spending ? { spending, review: parseSpadeReview(record?.review) } : undefined;
}

/**
 * Dollars from micros, cents always shown: "$1.00", "$12.40", "$1,250.00"; a spend under a cent
 * reads "<$0.01" so it never looks free.
 */
export function spadeMoney(value: number): string {
  const dollars = value / 1_000_000;
  if (dollars > 0 && dollars < 0.01) return "<$0.01";
  return money.format(dollars);
}
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
