import { fieldsLine, spadeContractResult, type SpadeContractOutcome } from "./contract-words.ts";
import { spadeRecord } from "./json.ts";

/*
 * A bot talking with another bot, as the person sees it (ADR 0127, ADR 0200 §7): the messages
 * one turn of a bot sent another (`bot_message`) as one conversation card in the sender's chat,
 * each with the reply once it came, and a call to another bot's contract (`contract_call`) as
 * the same card with what came back. Both stay in the chat with Show work off: they are who the
 * bot talked to, not how it worked. The fold keeps them in place as their jobs start and end;
 * the words here say how each card reads. A card never reads as finished while a reply is still
 * owed (AGENTS.md priority 1). Pure.
 */

/** The tool a bot messages another bot with. */
export const spadeBotMessageTool = "bot_message";

/** How one message to another bot ended: it answered, the message failed, or Stop ended it. */
export type SpadeTalkOutcome = "answered" | "failed" | "stopped";

/** One message and, once it came, its reply. */
export interface SpadeTalkExchange {
  /** The job the message runs as (the id of the call that sent it). */
  job: string;
  text: string;
  /** Undefined while the reply is still owed. */
  outcome: SpadeTalkOutcome | undefined;
  /** The reply's words, or why there is none. */
  answer: string;
  /** When it was sent, and when the reply came. */
  at?: number;
  answeredAt?: number;
}

/**
 * The messages one turn of this bot sent to one other bot, as one card where the first was
 * sent. `bot` is how the bot named it (its id or its exact name); views read its name and face.
 */
export interface SpadeTalkEntry {
  kind: "talk";
  key: string;
  /** The reply (turn) that sent them: a later turn's messages start a card of their own. */
  reply: string;
  bot: string;
  machine?: string;
  exchanges: readonly SpadeTalkExchange[];
  at?: number;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** `call_tool` carries the tool it reaches inside: `{name, arguments}`. */
function messageArguments(argumentsValue: unknown): Record<string, unknown> | undefined {
  const outer = spadeRecord(argumentsValue);
  if (outer && text(outer.name) && outer.arguments !== undefined)
    return spadeRecord(outer.arguments);
  return outer;
}

/** How far back a new message looks for its turn's card with the same bot. */
const joinReach = 64;

/**
 * A `bot_message` job started: it joins the card its turn already has with that bot, or the
 * card to place where it was sent is returned. `entries` is changed in place when it joins.
 */
export function spadeTalkStarted(
  state: {
    entries: ({ kind: string } | SpadeTalkEntry)[];
    calls: ReadonlyMap<string, { arguments?: unknown }>;
  },
  key: string,
  event: { job: string; reply: string },
  stored: { at: number },
): SpadeTalkEntry | undefined {
  const entries = state.entries;
  const start = {
    key,
    job: event.job,
    reply: event.reply,
    at: stored.at > 0 ? stored.at : undefined,
  };
  const fields = messageArguments(state.calls.get(event.job)?.arguments);
  const bot = text(fields?.bot) || "another bot";
  const machine = text(fields?.machine) || undefined;
  const exchange: SpadeTalkExchange = {
    job: start.job,
    text: text(fields?.text),
    outcome: undefined,
    answer: "",
    ...(start.at === undefined ? {} : { at: start.at }),
  };
  for (let at = entries.length - 1; at >= 0 && at >= entries.length - joinReach; at--) {
    const card = entries[at];
    if (!card || !isTalk(card)) continue;
    if (card.reply !== start.reply || card.bot !== bot || card.machine !== machine) continue;
    if (card.exchanges.some((each) => each.job === start.job)) return undefined;
    entries[at] = { ...card, exchanges: [...card.exchanges, exchange] };
    return undefined;
  }
  return {
    kind: "talk",
    key: start.key,
    reply: start.reply,
    bot,
    ...(machine ? { machine } : {}),
    exchanges: [exchange],
    ...(start.at === undefined ? {} : { at: start.at }),
  };
}

const isTalk = (entry: { kind: string }): entry is SpadeTalkEntry => entry.kind === "talk";

/** `Writing answered:\n…` (or `Writing on Studio answered:\n…`): the reply's own words. */
function answerOf(content: string): string {
  const trimmed = content.trim();
  const head = /^[^\n]*? answered:\n/.exec(trimmed);
  return head ? trimmed.slice(head[0].length).trim() : trimmed;
}

/**
 * A job ended: when it was a message to another bot, its row settles with the reply or why
 * there is none, and true is returned. `entries` is changed in place.
 */
export function spadeTalkFinished(
  entries: ({ kind: string } | SpadeTalkEntry)[],
  end: { job: string; content: string; error: boolean; stopped: boolean; at: number | undefined },
): boolean {
  for (let at = entries.length - 1; at >= 0; at--) {
    const card = entries[at];
    if (!card || !isTalk(card)) continue;
    const index = card.exchanges.findIndex((each) => each.job === end.job);
    const exchange = card.exchanges[index];
    if (!exchange) continue;
    const outcome: SpadeTalkOutcome = end.stopped ? "stopped" : end.error ? "failed" : "answered";
    entries[at] = {
      ...card,
      exchanges: card.exchanges.with(index, {
        ...exchange,
        outcome,
        answer: outcome === "answered" ? answerOf(end.content) : firstLine(end.content),
        ...(end.at === undefined ? {} : { answeredAt: end.at }),
      }),
    };
    return true;
  }
  return false;
}

const firstLine = (content: string) => content.trim().split("\n")[0]?.trim() ?? "";

/** A contract call this bot made, as the fold keeps it (ADR 0200 §7). */
export interface SpadeContractEntry {
  kind: "contract";
  key: string;
  job: string;
  /** The reply (turn) that made it: its turn's card holds it. */
  reply?: string;
  /** What it asked with, its input's fields in one line. */
  input?: string;
  /** The called bot's name, and its id for its face. */
  bot: string;
  botId?: string;
  machine?: string | undefined;
  contract: string;
  outcome: SpadeContractOutcome | undefined;
  /** The output's fields in one line, or why there is none. */
  result: string;
  at?: number;
  answeredAt?: number;
}

/** `contract_called`: the card to place where the call was made. */
export function spadeContractCalled(
  key: string,
  event: {
    job: string;
    bot: string;
    name: string;
    machine_name?: string | null | undefined;
    contract: string;
  },
  at: number | undefined,
  state: {
    jobs: ReadonlyMap<string, { reply: string }>;
    calls: ReadonlyMap<string, { arguments?: unknown }>;
  },
): SpadeContractEntry {
  const reply = state.jobs.get(event.job)?.reply;
  const fields = messageArguments(state.calls.get(event.job)?.arguments);
  const input = spadeRecord(fields?.input);
  return {
    kind: "contract",
    key,
    job: event.job,
    ...(reply ? { reply } : {}),
    ...(input ? { input: fieldsLine(input) } : {}),
    bot: event.name || "Another bot",
    ...(event.bot ? { botId: event.bot } : {}),
    ...(event.machine_name ? { machine: event.machine_name } : {}),
    contract: event.contract,
    outcome: undefined,
    result: "",
    ...(at === undefined ? {} : { at }),
  };
}

/** A job ended: when it was a contract call, its card settles with what came back. */
export function spadeContractFinished(
  entries: ({ kind: string } | SpadeContractEntry)[],
  end: { job: string; content: string; stopped: boolean; at: number | undefined },
): boolean {
  const index = entries.findIndex((entry) => isContract(entry) && entry.job === end.job);
  const card = entries[index];
  if (!card || !isContract(card)) return false;
  const read = spadeContractResult(end.content);
  entries[index] = {
    ...card,
    outcome: end.stopped ? "stopped" : read.outcome,
    result: read.result,
    ...(end.at === undefined ? {} : { answeredAt: end.at }),
  };
  return true;
}

const isContract = (entry: { kind: string }): entry is SpadeContractEntry =>
  entry.kind === "contract";

/** A contract call another bot made to this one, kept on the message that delivered it. */
export interface SpadeContractAsked {
  call: string;
  contract: string;
  /** Its input's fields in one line. */
  input: string;
  /** How it ended, once it did: what this bot returned in one line, or why there is none. */
  ended?: { outcome: SpadeContractOutcome; text: string };
}

/** The call a delivered message carries, as the receiver's chat keeps it. */
export function spadeContractAsked(contract: {
  call: string;
  contract: string;
  input: unknown;
}): SpadeContractAsked {
  const fields = spadeRecord(contract.input);
  return {
    call: contract.call,
    contract: contract.contract,
    input: fields ? fieldsLine(fields) : text(contract.input),
  };
}

/** The message that delivered a contract call, as far as its return reads it. */
interface SpadeAskedEntry {
  kind: "user";
  fromAgent?: { id: string; name: string; contract?: SpadeContractAsked };
}

const isAsked = (entry: { kind: string }): entry is SpadeAskedEntry => entry.kind === "user";

/**
 * A contract call made to this bot ended (`contract_ended`): the message that asked keeps how,
 * with what it returned. True when one did; `entries` is changed in place.
 */
export function spadeContractEnded(
  entries: ({ kind: string } | SpadeAskedEntry)[],
  event: {
    call: string;
    status: SpadeContractOutcome;
    output?: unknown;
    problems: readonly string[];
    why: string;
  },
): boolean {
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at];
    if (!entry || !isAsked(entry) || !entry.fromAgent) continue;
    const asked = entry.fromAgent.contract;
    if (asked?.call !== event.call) continue;
    const output = spadeRecord(event.output);
    const words =
      event.status === "returned"
        ? output
          ? fieldsLine(output)
          : plain(event.output)
        : event.status === "failed"
          ? event.problems.join("; ")
          : event.why.trim();
    const ended = { outcome: event.status, text: words };
    entries[at] = { ...entry, fromAgent: { ...entry.fromAgent, contract: { ...asked, ended } } };
    return true;
  }
  return false;
}

/** A returned value that isn't an object, as one line. */
const plain = (value: unknown) =>
  typeof value === "string"
    ? value.trim()
    : value === undefined || value === null
      ? ""
      : JSON.stringify(value);

/** `cheapest_fare` → "cheapest fare": a contract's name as words, or its declared title. */
export function spadeContractTitle(name: string, declared?: string): string {
  const title = declared?.trim();
  if (title) return title;
  return name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase() || name;
}
