import { z } from "zod";
import { parseSpadeAvatar, type SpadeAvatar } from "./agents.ts";
import { spadeJson, spadeRecord } from "./json.ts";
import { spadeMoney } from "./oversight.ts";
import { spadeRestTime, type SpadeRestClock } from "./wakes.ts";

/*
 * The task manager (ADR 0200 §6.3): every bot that runs, from `GET /v1/running`, one row per bot
 * with its workers under it. Spade folds the rows and their words (`spade_core::running`); this
 * reads them leniently and says the rest in words, so the web page, the desktop and the CLI show
 * the same list. A row this client can't read is left out; an unknown state reads as idle.
 */

/** A bot's rolled-up state (ADR 0200 §6.2). */
export type SpadeRunningState = "idle" | "working" | "waiting" | "sleeping" | "paused";

/** How a row reads, in the order rows sort. */
export type SpadeRunningReads = "needs_you" | "working" | "failed" | "sleeping" | "paused" | "idle";

/** What the person may do to a bot now. */
export type SpadeRunningAction = "stop" | "pause" | "resume";

export interface SpadeRunningWorker {
  id: string;
  name: string;
  state: SpadeRunningState;
  doing: string;
}

export interface SpadeRunningBot {
  id: string;
  name: string;
  kind: "main" | "bot";
  conversation: string;
  /** Its face; Spade's own bot always shows the Spade mark. */
  avatar: SpadeAvatar;
  state: SpadeRunningState;
  reads: SpadeRunningReads;
  /** Its state in words, as Spade says it: "Checking fares", "Waiting on you: a question". */
  doing: string;
  failure: string | undefined;
  pausedAt: number | undefined;
  uses: { answering: boolean; jobs: number; workers: number; services: number; agents: boolean };
  spend: {
    todayMicros: number;
    monthMicros: number;
    lastHourMicros: number;
    /** The hourly spend above which the person is told; undefined while alerts are off. */
    alertLineMicros: number | undefined;
    unusual: boolean;
  };
  network: { sentBytes: number; receivedBytes: number; hosts: string[]; refused: number };
  nextWake: { at: number; what: string } | undefined;
  workers: SpadeRunningWorker[];
  actions: SpadeRunningAction[];
}

const count = z.number().int().nonnegative().catch(0).default(0);
const micros = z.number().nonnegative().catch(0).default(0);
const state = z
  .enum(["idle", "working", "waiting", "sleeping", "paused"])
  .catch("idle")
  .default("idle");
const reads = z
  .enum(["needs_you", "working", "failed", "sleeping", "paused", "idle"])
  .catch("idle")
  .default("idle");

const rowShape = z.object({
  id: z.string().min(1),
  name: z.string().catch(""),
  kind: z.enum(["main", "bot"]).catch("bot").default("bot"),
  conversation: z.string().catch(""),
  avatar: z.unknown().optional(),
  state,
  reads,
  doing: z.string().catch(""),
  failure: z.string().nullish().catch(undefined),
  paused_at_ms: z.number().nullish().catch(undefined),
  uses: z
    .object({
      answering: z.boolean().catch(false).default(false),
      jobs: count,
      workers: count,
      services: count,
      agents: z.boolean().catch(false).default(false),
    })
    .catch({ answering: false, jobs: 0, workers: 0, services: 0, agents: false })
    .default({ answering: false, jobs: 0, workers: 0, services: 0, agents: false }),
  spend: z
    .object({
      today_micros: micros,
      month_micros: micros,
      last_hour_micros: micros,
      alert_line_micros: z.number().nonnegative().nullish().catch(undefined),
      unusual: z.boolean().catch(false).default(false),
    })
    .catch({ today_micros: 0, month_micros: 0, last_hour_micros: 0, unusual: false })
    .default({ today_micros: 0, month_micros: 0, last_hour_micros: 0, unusual: false }),
  network: z
    .object({
      sent_bytes: count,
      received_bytes: count,
      hosts: z.array(z.string()).catch([]).default([]),
      refused: count,
    })
    .catch({ sent_bytes: 0, received_bytes: 0, hosts: [], refused: 0 })
    .default({ sent_bytes: 0, received_bytes: 0, hosts: [], refused: 0 }),
  next_wake: z
    .object({ at_ms: z.number(), what: z.string().catch("") })
    .nullish()
    .catch(undefined),
  workers: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().catch(""),
        state,
        doing: z.string().catch(""),
      }),
    )
    .catch([])
    .default([]),
  actions: z.array(z.string()).catch([]).default([]),
});

const isAction = (action: string): action is SpadeRunningAction =>
  action === "stop" || action === "pause" || action === "resume";

/** One row; undefined when it has no id. */
export function parseSpadeRunningBot(raw: unknown): SpadeRunningBot | undefined {
  const parsed = rowShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const row = parsed.data;
  const main = row.kind === "main";
  return {
    id: row.id,
    name: main ? "Spade" : row.name || "Bot",
    kind: row.kind,
    conversation: row.conversation,
    avatar: main ? { kind: "spade" } : parseSpadeAvatar(row.avatar, row.id),
    state: row.state,
    reads: row.reads,
    doing: row.doing || spadeRunningReadsWords[row.reads],
    failure: row.failure ?? undefined,
    pausedAt: row.paused_at_ms ?? undefined,
    uses: row.uses,
    spend: {
      todayMicros: row.spend.today_micros,
      monthMicros: row.spend.month_micros,
      lastHourMicros: row.spend.last_hour_micros,
      alertLineMicros: row.spend.alert_line_micros ?? undefined,
      unusual: row.spend.unusual,
    },
    network: {
      sentBytes: row.network.sent_bytes,
      receivedBytes: row.network.received_bytes,
      hosts: row.network.hosts,
      refused: row.network.refused,
    },
    nextWake: row.next_wake ? { at: row.next_wake.at_ms, what: row.next_wake.what } : undefined,
    workers: row.workers.map((worker) => ({ ...worker, name: worker.name || "Worker" })),
    actions: row.actions.filter(isAction),
  };
}

/** `GET /v1/running` (or an action's answer); undefined when the body has no `bots` list. */
export function parseSpadeRunning(body: string): SpadeRunningBot[] | undefined {
  const bots = spadeRecord(spadeJson(body))?.bots;
  if (!Array.isArray(bots)) return undefined;
  return bots.flatMap((raw) => parseSpadeRunningBot(raw) ?? []);
}

const spadeRunningReadsWords: Record<SpadeRunningReads, string> = {
  needs_you: "Waiting on you",
  working: "Working",
  failed: "Failed",
  sleeping: "Sleeping",
  paused: "Paused",
  idle: "Idle",
};

const readsRank: Record<SpadeRunningReads, number> = {
  needs_you: 0,
  working: 1,
  failed: 2,
  sleeping: 3,
  paused: 4,
  idle: 5,
};

/**
 * Rows from several machines' Spades as one list: needs you, working, failed, sleeping, paused,
 * then idle, by name within each. Spade's own bot is an ordinary row.
 */
export function spadeRunningOrder<T extends Pick<SpadeRunningBot, "reads" | "name" | "id">>(
  rows: readonly T[],
): T[] {
  return rows.toSorted(
    (a, b) =>
      readsRank[a.reads] - readsRank[b.reads] ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What it holds open, in words: "Answering · 2 jobs · 1 worker · 1 service"; empty for none. */
export function spadeRunningUsesWords(uses: SpadeRunningBot["uses"]): string {
  return [
    uses.answering ? "Answering" : undefined,
    uses.jobs > 0 ? plural(uses.jobs, "job") : undefined,
    uses.workers > 0 ? plural(uses.workers, "worker") : undefined,
    uses.services > 0 ? plural(uses.services, "service") : undefined,
    uses.agents ? "Coding agents" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Spend in words: "$0.42 today · $3.10 this month", and "Spending fast" while unusual. */
export function spadeRunningSpendWords(spend: SpadeRunningBot["spend"]): string {
  const said = `${spadeMoney(spend.todayMicros)} today · ${spadeMoney(spend.monthMicros)} this month`;
  return spend.unusual ? `${said} · Spending fast` : said;
}

/** The spend alert's line in words: "Alerts above $1.00 an hour"; undefined while alerts are off. */
export function spadeRunningAlertWords(spend: SpadeRunningBot["spend"]): string | undefined {
  return spend.alertLineMicros === undefined
    ? undefined
    : `Alerts above ${spadeMoney(spend.alertLineMicros)} an hour`;
}

/** Bytes as the person reads them: "820 B", "1.2 MB". */
export function spadeBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Network today in words: "1.2 MB with api.fares.dev and 2 more"; "No network today" for none. */
export function spadeRunningNetworkWords(network: SpadeRunningBot["network"]): string {
  const bytes = network.sentBytes + network.receivedBytes;
  const [first, ...rest] = network.hosts;
  const refused = network.refused > 0 ? ` · ${network.refused} refused` : "";
  if (!first) return network.refused > 0 ? `No network today${refused}` : "No network today";
  const hosts = rest.length > 0 ? `${first} and ${rest.length} more` : first;
  return `${spadeBytes(bytes)} with ${hosts}${refused}`;
}

/**
 * When it next does something by itself: "Next: Morning check, 8:20 AM". A paused bot's comes
 * only once it is resumed: "Held: Morning check, 8:20 AM". Undefined for nothing ahead.
 */
export function spadeRunningWakeWords(
  bot: Pick<SpadeRunningBot, "nextWake" | "pausedAt">,
  clock: SpadeRestClock,
): string | undefined {
  const next = bot.nextWake;
  if (!next) return undefined;
  const lead = bot.pausedAt === undefined ? "Next" : "Held";
  const time = spadeRestTime(next.at, clock);
  return next.what ? `${lead}: ${next.what}, ${time}` : `${lead}: ${time}`;
}
