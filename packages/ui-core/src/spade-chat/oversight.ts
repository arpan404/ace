import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * Spending caps and the model review (ADR 0135, spade/docs/oversight.md), as Spade's API sends
 * them. Money is in micros, millionths of a US dollar. Parsed leniently: a field this client
 * can't read falls back to "not set", and every value keeps what it came with in `raw`.
 */

export type SpadeCapScope = "daily" | "monthly";

/** A bot's spend so far and its caps. */
export interface SpadeSpending {
  todayMicros: number;
  monthMicros: number;
  /** Undefined: no cap. */
  dailyCapMicros: number | undefined;
  monthlyCapMicros: number | undefined;
  /** The cap it is at now, if any. */
  capped: SpadeCapScope | undefined;
  /** When the cap that holds it ends. */
  resetsAt: number | undefined;
}

/** The service's oversight: the person's zone, its cap and spend, and the review default. */
export interface SpadeOversight {
  timeZone: string;
  /** `SPADE_DAILY_CAP_USD`, read only. */
  dailyCapMicros: number | undefined;
  todayMicros: number;
  monthMicros: number;
  reviewDefault: boolean;
  /** `endpoint/model`; undefined uses the fast model, else each bot's own. */
  reviewModel: string | undefined;
  raw: Record<string, unknown>;
}

const micros = z.number().nonnegative();
const scope = z.enum(["daily", "monthly"]);
const spendingShape = z.object({
  today_micros: micros.catch(0).default(0),
  month_micros: micros.catch(0).default(0),
  daily_cap_micros: micros.nullish().catch(undefined),
  monthly_cap_micros: micros.nullish().catch(undefined),
  capped: scope.nullish().catch(undefined),
  resets_at: z.number().nullish().catch(undefined),
});

/** A Spending value; undefined when it isn't an object. */
export function parseSpadeSpending(raw: unknown): SpadeSpending | undefined {
  const parsed = spendingShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return {
    todayMicros: value.today_micros,
    monthMicros: value.month_micros,
    dailyCapMicros: value.daily_cap_micros ?? undefined,
    monthlyCapMicros: value.monthly_cap_micros ?? undefined,
    capped: value.capped ?? undefined,
    resetsAt: value.resets_at ?? undefined,
  };
}

/** A bot's own review switch: on, off, or undefined to follow the default. */
export function parseSpadeReview(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

const oversightShape = z.object({
  time_zone: z.string().catch(""),
  daily_cap_micros: micros.nullish().catch(undefined),
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
    dailyCapMicros: value.daily_cap_micros ?? undefined,
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

/**
 * Dollars a person typed ("1", "$2.50", "0.001") as micros; undefined for empty, null for
 * anything that isn't a sum Spade can store exactly: not a number, more than six decimal places
 * (a micro is the smallest unit), or too large to hold as a whole number of micros.
 */
export function spadeMicrosOf(typed: string): number | undefined | null {
  const text = typed.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!text) return undefined;
  const parts = /^(\d*)(?:\.(\d{0,6}))?$/.exec(text);
  if (!parts || text === ".") return null;
  // Whole dollars and micros added as integers, so no float rounding moves a cap.
  const total = Number(parts[1] || "0") * 1_000_000 + Number((parts[2] ?? "").padEnd(6, "0"));
  return Number.isSafeInteger(total) ? total : null;
}

/** Micros as the dollars an input shows, exactly: "1", "2.5", "0.001"; empty for no cap. */
export function spadeDollarsOf(value: number | undefined): string {
  if (value === undefined) return "";
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** The roster's muted words for a bot at a cap. */
export function spadeCappedLine(capped: SpadeCapScope): string {
  return capped === "daily" ? "At its daily cap" : "At its monthly cap";
}

/** What a bot says, once, when it reaches a cap. */
export function spadeCapSentence(cap: SpadeCapScope, capMicros: number): string {
  const until = cap === "daily" ? "until midnight" : "until the start of next month";
  return `I've reached my ${cap} spending cap of ${spadeMoney(capMicros)}, so I've stopped ${until}. You can raise it in my settings.`;
}

/** A bot's caps in a few words: "Caps: $1.00 a day, $20.00 a month", or "No caps". */
export function spadeCapsWords(spending: SpadeSpending): string {
  const caps = [
    ...(spending.dailyCapMicros === undefined
      ? []
      : [`${spadeMoney(spending.dailyCapMicros)} a day`]),
    ...(spending.monthlyCapMicros === undefined
      ? []
      : [`${spadeMoney(spending.monthlyCapMicros)} a month`]),
  ];
  return caps.length ? `Caps: ${caps.join(", ")}` : "No caps";
}
