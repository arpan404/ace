import { z } from "zod";

/*
 * The morning brief (ADR 0195, amending ADR 0165) as `GET /v1/digests` lists it: a row of kind
 * `brief` beside the main bot's conversation. What finished (each line opening the event it came
 * from), what waits on the person with the answers a tap can give, today's routines and spend.
 * Parsed leniently: a part that doesn't read is left out, never the whole brief.
 */

const words = z.string().catch("").default("");
const count = z.number().int().nonnegative().catch(0).default(0);
const rawList = z.array(z.unknown()).catch([]).default([]);
/** The rows of a list that read as `item`; the rest are left out. */
const keep =
  <T extends z.ZodType>(item: T) =>
  (rows: unknown[]) =>
    rows.flatMap((row) => {
      const parsed = item.safeParse(row);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    });
const list = <T extends z.ZodType>(item: T) => rawList.transform(keep(item));

const finished = z.object({
  agent: z.string(),
  name: words,
  conversation: z.string(),
  seq: z.number().int(),
  text: z.string(),
});
const waiting = z.object({
  agent: z.string(),
  name: words,
  conversation: z.string(),
  kind: z.enum(["approval", "question"]),
  call_id: z.string().min(1),
  what: z.string(),
  answer: z.enum(["approval", "choice", "confirm"]).optional().catch(undefined),
  options: list(z.string()),
});
const planned = z.object({ name: words, routine: z.string(), at_ms: z.number() });
const away = z.object({ name: words, text: z.string() });
const brief = z.object({
  finished: list(finished),
  more_finished: count,
  waiting: list(waiting),
  today: list(planned),
  spend: z
    .object({
      total_micros: count,
      bots: list(z.object({ name: words, micros: count })),
    })
    .catch({ total_micros: 0, bots: [] })
    .default({ total_micros: 0, bots: [] }),
  away: list(away),
});

/** One open request in a brief, answerable there when `answer` says how. */
export interface SpadeBriefWaiting {
  agent: string;
  name: string;
  conversation: string;
  kind: "approval" | "question";
  callId: string;
  what: string;
  /** `approval`: Allow once or Deny; `choice`: one of `options`; `confirm`: yes or no. */
  answer: "approval" | "choice" | "confirm" | undefined;
  options: string[];
}

export interface SpadeBrief {
  finished: { agent: string; name: string; conversation: string; seq: number; text: string }[];
  moreFinished: number;
  waiting: SpadeBriefWaiting[];
  today: { name: string; routine: string; at: number }[];
  spendMicros: number;
  spend: { name: string; micros: number }[];
  away: { name: string; text: string }[];
}

/** A brief row's `digest`; undefined when it isn't one. */
export function parseSpadeBrief(raw: unknown): SpadeBrief | undefined {
  const parsed = brief.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return {
    finished: value.finished,
    moreFinished: value.more_finished,
    waiting: value.waiting.map((w) => ({
      agent: w.agent,
      name: w.name,
      conversation: w.conversation,
      kind: w.kind,
      callId: w.call_id,
      what: w.what,
      answer: w.answer,
      options: w.options,
    })),
    today: value.today.map((p) => ({ name: p.name, routine: p.routine, at: p.at_ms })),
    spendMicros: value.spend.total_micros,
    spend: value.spend.bots,
    away: value.away,
  };
}
