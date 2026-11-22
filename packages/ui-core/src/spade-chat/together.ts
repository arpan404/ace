import type { SubagentState } from "../subagents.ts";
import {
  spadeContractTitle,
  type SpadeContractAsked,
  type SpadeContractEntry,
  type SpadeTalkEntry,
  type SpadeTalkExchange,
} from "./bot-talk.ts";
import type { SpadeStartedWorker, SpadeWorkersEntry } from "./delegations.ts";
import { spadeSubagentHeader, spadeSubagentTone, type SpadeSubagentLine } from "./subagent-card.ts";

/*
 * Everything one turn of a bot did with other bots and agents, as one card (docs/design/spade.md,
 * "Working with other bots"): the messages it sent other bots with their replies, the contracts
 * it called with what came back, and the ace agents and bots it started. The card is the
 * subagent card, its header one sentence about whom the bot worked with, one row per exchange,
 * call or agent; a message's or a call's row opens to the exchange as a short transcript.
 * Nothing here says worked while a reply is owed or an agent still works (AGENTS.md priority 1).
 * Pure: `spadeBubbles` keeps the parts as they are, for clients that draw them apart.
 */

/** The messages one turn sent another bot (`spadeBubbles`' `talk`). */
export type SpadeTogetherTalk = { kind: "talk" } & Omit<SpadeTalkEntry, "kind" | "at"> & {
    at?: number;
  };

/** A contract call (`spadeBubbles`' `contract`). */
export interface SpadeTogetherContract {
  kind: "contract";
  key: string;
  call: Omit<SpadeContractEntry, "kind" | "key">;
  state: SubagentState;
  at?: number;
}

/** The workers one call started (`spadeBubbles`' `workers`). */
export type SpadeTogetherWorkers = Omit<SpadeWorkersEntry, "at"> & { at?: number };

export type SpadeTogetherPart = SpadeTogetherTalk | SpadeTogetherContract | SpadeTogetherWorkers;

/** One turn's card: its parts in the order they happened, where the first happened. */
export interface SpadeTogetherBubble {
  kind: "together";
  key: string;
  parts: readonly SpadeTogetherPart[];
  at?: number;
}

const isPart = (bubble: { kind: string }): bubble is SpadeTogetherPart =>
  bubble.kind === "talk" || bubble.kind === "contract" || bubble.kind === "workers";

/** The turn a part belongs to: its reply, else itself alone. */
function turnOf(part: SpadeTogetherPart): string {
  const reply = part.kind === "contract" ? part.call.reply : part.reply;
  return reply ? `reply:${reply}` : `part:${part.key}`;
}

/**
 * The chat's bubbles with each turn's messages to other bots, contract calls and started workers
 * folded into one card, where the first of them happened. Everything else keeps its place.
 */
export function spadeTogether<T extends { kind: string; key: string }>(
  bubbles: readonly T[],
): (T | SpadeTogetherBubble)[] {
  const out: (T | SpadeTogetherBubble)[] = [];
  const cards = new Map<string, number>();
  for (const bubble of bubbles) {
    if (!isPart(bubble)) {
      out.push(bubble);
      continue;
    }
    const turn = turnOf(bubble);
    const at = cards.get(turn);
    const card = at === undefined ? undefined : out[at];
    if (at !== undefined && card?.kind === "together" && "parts" in card) {
      out[at] = { ...card, parts: [...card.parts, bubble] };
      continue;
    }
    cards.set(turn, out.length);
    out.push({
      kind: "together",
      key: `together:${bubble.key}`,
      parts: [bubble],
      ...(bubble.at === undefined ? {} : { at: bubble.at }),
    });
  }
  return out;
}

/** One row of a turn's card: an agent it started, a message and its reply, or a contract call. */
export type SpadeTogetherRow =
  | { kind: "worker"; key: string; worker: SpadeStartedWorker }
  | { kind: "message"; key: string; bot: string; machine?: string; exchange: SpadeTalkExchange }
  | { kind: "contract"; key: string; call: SpadeTogetherContract["call"] };

/** The card's rows, in the order they happened: one per agent, per message, per call. */
export function spadeTogetherRows(parts: readonly SpadeTogetherPart[]): SpadeTogetherRow[] {
  return parts.flatMap((part): SpadeTogetherRow[] => {
    if (part.kind === "workers")
      return part.workers.map((worker) => ({
        kind: "worker",
        key: `${part.key}:${worker.id}`,
        worker,
      }));
    if (part.kind === "contract") return [{ kind: "contract", key: part.key, call: part.call }];
    return part.exchanges.map((exchange) => ({
      kind: "message",
      key: `${part.key}:${exchange.job}`,
      bot: part.bot,
      ...(part.machine ? { machine: part.machine } : {}),
      exchange,
    }));
  });
}

/** A message's or a call's state, in ace's words for a child: never done while it is owed. */
export function spadeTogetherState(
  row: Exclude<SpadeTogetherRow, { kind: "worker" }>,
): SubagentState {
  const outcome = row.kind === "message" ? row.exchange.outcome : row.call.outcome;
  switch (outcome) {
    case undefined:
      return "working";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
    default:
      return "done";
  }
}

/** When a message or a call was sent and, once it was, answered. */
export function spadeTogetherSpan(row: Exclude<SpadeTogetherRow, { kind: "worker" }>): {
  startedAt?: number;
  endedAt?: number;
} {
  const { at, answeredAt } = row.kind === "message" ? row.exchange : row.call;
  return {
    ...(at === undefined ? {} : { startedAt: at }),
    ...(answeredAt ? { endedAt: answeredAt } : {}),
  };
}

const firstLine = (words: string) => words.trim().split("\n")[0]?.trim() ?? "";

const capital = (words: string) => (words[0]?.toUpperCase() ?? "") + words.slice(1);

/**
 * A message's or a call's second line, in plain words, under the other bot's name: "Replied:
 * Three days on the river…", "Cheapest fare: €78 with TAP", "Couldn't get the seat map: closed
 * until check-in". While owed: the other bot's own working phrase (it shimmers), else that it is
 * working on it.
 */
export function spadeTogetherLine(
  row: Exclude<SpadeTogetherRow, { kind: "worker" }>,
  phrase?: string | undefined,
): SpadeSubagentLine {
  const tone = spadeSubagentTone(spadeTogetherState(row));
  const line = (text: string, live = false): SpadeSubagentLine => ({ text, tone, live });
  if (row.kind === "message") {
    const { outcome, answer } = row.exchange;
    const why = firstLine(answer);
    switch (outcome) {
      case undefined:
        return line(phrase?.trim() || "Working on it", true);
      case "answered":
        return line(why ? `Replied: ${why}` : "Replied");
      case "failed":
        return line(why ? `Couldn't reach it: ${why}` : "Couldn't reach it");
      case "stopped":
        return line("Stopped before it replied");
    }
  }
  const title = spadeContractTitle(row.call.contract);
  const result = firstLine(row.call.result);
  switch (row.call.outcome) {
    case undefined:
      return line(phrase?.trim() || `Getting the ${title}`, true);
    case "returned":
      return line(result ? `${capital(title)}: ${result}` : capital(title));
    case "failed":
      return line(result ? `Couldn't get the ${title}: ${result}` : `Couldn't get the ${title}`);
    case "stopped":
      return line(`Stopped asking for the ${title}`);
  }
}

/** One line of an opened row's transcript: who said it, and all of it. */
export interface SpadeTranscriptLine {
  key: string;
  /** This bot or the other one. */
  from: "self" | "other";
  name: string;
  text: string;
  /** Still owed: the other bot's live phrase, in the step's light. */
  live: boolean;
  failed: boolean;
}

/**
 * An opened row: what this bot sent, then what came back, each under its sender's name and in
 * full. A reply still owed reads as the other bot's live phrase.
 */
export function spadeTogetherTranscript(
  row: Exclude<SpadeTogetherRow, { kind: "worker" }>,
  names: { self: string; other: string; phrase?: string | undefined },
): SpadeTranscriptLine[] {
  const said = (from: "self" | "other", text: string, live = false, failed = false) => ({
    key: `${row.key}:${from}`,
    from,
    name: from === "self" ? names.self : names.other,
    text,
    live,
    failed,
  });
  const owed = said("other", names.phrase?.trim() || "Working on it", true);
  if (row.kind === "message") {
    const { exchange } = row;
    const sent = said("self", exchange.text);
    switch (exchange.outcome) {
      case undefined:
        return [sent, owed];
      case "answered":
        return [sent, said("other", exchange.answer.trim() || "Replied")];
      case "failed":
        return [sent, said("other", exchange.answer.trim() || "Couldn't reach it", false, true)];
      case "stopped":
        return [sent, said("other", "Stopped before it replied")];
    }
  }
  const title = spadeContractTitle(row.call.contract);
  const input = row.call.input?.trim();
  const sent = said("self", input ? `Asked for the ${title}: ${input}` : `Asked for the ${title}`);
  switch (row.call.outcome) {
    case undefined:
      return [sent, owed];
    case "returned":
      return [sent, said("other", row.call.result.trim() || "Answered")];
    case "failed":
      return [sent, said("other", row.call.result.trim() || "Couldn't answer", false, true)];
    case "stopped":
      return [sent, said("other", `Stopped asking for the ${title}`)];
  }
}

/** "Writing", "Writing and Flight watcher", "Writing, Flight watcher and Research". */
function listWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} others`] : names;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * The card's first line: "Quill is working with Writing and Flight watcher" while anything in it
 * is owed or at work (or what it reads isn't current), "Quill worked with …" once all has ended.
 * Bots by name, ace agents counted ("and 2 agents"). A card of started workers alone reads as the
 * subagent card does ("Quill worked with 4 agents").
 */
export function spadeTogetherHeader(
  bot: string,
  rows: readonly { name: string; ace: boolean; state: SubagentState }[],
  options: { current: boolean; workersOnly: boolean },
): string {
  const states = rows.map((row) => row.state);
  if (options.workersOnly) return spadeSubagentHeader(bot, states, options);
  const names = [...new Set(rows.filter((row) => !row.ace).map((row) => row.name))];
  const ace = rows.filter((row) => row.ace).length;
  const words = listWords(ace ? [...names, `${ace} agent${ace === 1 ? "" : "s"}`] : names);
  const ended = options.current && states.every((state) => terminal.has(state));
  return ended ? `${bot} worked with ${words}` : `${bot} is working with ${words}`;
}

const terminal = new Set<SubagentState>(["done", "failed", "cancelled"]);

/**
 * In the receiver's chat, a contract call it was given as one compact row: "Quill asked for the
 * cheapest fare · fare €78 · currency EUR", what it returned once it did, else that it is on it.
 */
export function spadeContractAskedLine(
  asked: SpadeContractAsked,
  names: { from: string; working: boolean },
): SpadeSubagentLine {
  const head = `${names.from} asked for the ${spadeContractTitle(asked.contract)}`;
  const ended = asked.ended;
  switch (ended?.outcome) {
    case "returned":
      return { text: ended.text ? `${head} · ${ended.text}` : head, tone: "settled", live: false };
    case "failed":
      return {
        text: ended.text ? `${head} · Couldn't answer: ${ended.text}` : `${head} · Couldn't answer`,
        tone: "failed",
        live: false,
      };
    case "stopped":
      return { text: `${head} · ${names.from} stopped asking`, tone: "settled", live: false };
    case undefined:
      return names.working
        ? { text: `${head} · Working on it`, tone: "working", live: true }
        : { text: `${head} · Not answered yet`, tone: "settled", live: false };
  }
}
