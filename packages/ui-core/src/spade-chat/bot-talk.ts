import { pluralCount } from "../counts.ts";
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

/** The tool a bot answers a contract call with. */
export const spadeContractReturnTool = "contract_return";

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
  if (outer && text(outer.name) === spadeBotMessageTool) return spadeRecord(outer.arguments);
  return outer;
}

/** How far back a new message looks for its turn's card with the same bot. */
const joinReach = 64;

/**
 * A `bot_message` job started: it joins the card its turn already has with that bot, or the
 * card to place where it was sent is returned. `entries` is changed in place when it joins.
 */
export function spadeTalkStarted(
  entries: ({ kind: string } | SpadeTalkEntry)[],
  start: { key: string; job: string; reply: string; arguments: unknown; at: number | undefined },
): SpadeTalkEntry | undefined {
  const fields = messageArguments(start.arguments);
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
): SpadeContractEntry {
  return {
    kind: "contract",
    key,
    job: event.job,
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
  /** What this bot returned, in one line, once it did. */
  returned?: string;
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
 * This bot answered a contract call (`contract_return`): the message that asked keeps what it
 * returned. True when one did; `entries` is changed in place.
 */
export function spadeContractReturned(
  entries: ({ kind: string } | SpadeAskedEntry)[],
  argumentsValue: unknown,
): boolean {
  const fields = spadeRecord(argumentsValue);
  const call = text(fields?.call);
  if (!call) return false;
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at];
    const asked = entry && isAsked(entry) ? entry.fromAgent?.contract : undefined;
    if (!entry || !isAsked(entry) || !entry.fromAgent || asked?.call !== call) continue;
    const output = fields?.output;
    const record = spadeRecord(output);
    const returned = record ? fieldsLine(record) : text(output) || String(output ?? "");
    entries[at] = { ...entry, fromAgent: { ...entry.fromAgent, contract: { ...asked, returned } } };
    return true;
  }
  return false;
}

/** `cheapest_fare` → "cheapest fare": a contract's name as words, or its declared title. */
export function spadeContractTitle(name: string, declared?: string): string {
  const title = declared?.trim();
  if (title) return title;
  return name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase() || name;
}

/** How a card's row reads: quiet words, the live wait, a failure, or a settled answer. */
export type SpadeTalkTone = "quiet" | "working" | "failed" | "settled";

/** One row of a conversation card: who said it, and its one line. */
export interface SpadeTalkRow {
  key: string;
  /** This bot (`self`) or the other one. */
  from: "self" | "other";
  text: string;
  tone: SpadeTalkTone;
  /** It is the live wait for a reply: it shimmers. */
  live: boolean;
  at?: number;
}

/** A conversation card as every client draws it. */
export interface SpadeTalkCard {
  header: string;
  /** A reply is still owed: the card never reads as finished. */
  pending: boolean;
  rows: readonly SpadeTalkRow[];
}

/** What a card needs to say who: the two bots' names, and the other's live phrase if known. */
export interface SpadeTalkNames {
  self: string;
  other: string;
  /** What the other bot says it does now, while it works ("Reading the brief"). */
  otherPhrase?: string | undefined;
}

/** The row that waits for a reply: the other bot's live phrase, else that it is on it. */
function waitingRow(key: string, names: SpadeTalkNames): SpadeTalkRow {
  const phrase = names.otherPhrase?.trim();
  return {
    key,
    from: "other",
    text: phrase || `${names.other} is working on it`,
    tone: "working",
    live: true,
  };
}

/**
 * The sender's card: "Quill asked Writing" for one message, "Quill talked with Writing · 3
 * messages" for several ("is talking with" while a reply is owed); under it each message, then
 * its reply, the live wait, or why it has none.
 */
export function spadeTalkCard(entry: SpadeTalkEntry, names: SpadeTalkNames): SpadeTalkCard {
  const pending = entry.exchanges.some((each) => each.outcome === undefined);
  const count = entry.exchanges.length;
  const other = entry.machine ? `${names.other} on ${entry.machine}` : names.other;
  const header =
    count <= 1
      ? `${names.self} asked ${other}`
      : `${names.self} ${pending ? "is talking" : "talked"} with ${other} · ${pluralCount(count, "message")}`;
  const rows = entry.exchanges.flatMap((exchange): SpadeTalkRow[] => {
    const sent: SpadeTalkRow = {
      key: `${exchange.job}:sent`,
      from: "self",
      text: exchange.text,
      tone: "quiet",
      live: false,
      ...(exchange.at === undefined ? {} : { at: exchange.at }),
    };
    const key = `${exchange.job}:reply`;
    const when = exchange.answeredAt === undefined ? {} : { at: exchange.answeredAt };
    switch (exchange.outcome) {
      case undefined:
        return [sent, waitingRow(key, names)];
      case "answered":
        return [
          sent,
          {
            key,
            from: "other",
            text: exchange.answer || `${names.other} answered`,
            tone: "settled",
            live: false,
            ...when,
          },
        ];
      case "failed":
        return [
          sent,
          {
            key,
            from: "other",
            text: exchange.answer
              ? `Didn't reach ${names.other} · ${exchange.answer}`
              : `Didn't reach ${names.other}`,
            tone: "failed",
            live: false,
            ...when,
          },
        ];
      case "stopped":
        return [
          sent,
          {
            key,
            from: "other",
            text: `Stopped before ${names.other} answered`,
            tone: "quiet",
            live: false,
            ...when,
          },
        ];
    }
  });
  return { header, pending, rows };
}

/**
 * The caller's contract card: "Asked Flight watcher for the cheapest fare" ("Asking" while it
 * is owed); under it what came back in one line, the live wait, or why there is none.
 */
export function spadeContractCard(
  entry: Omit<SpadeContractEntry, "kind" | "key">,
  names: { otherPhrase?: string | undefined; title?: string | undefined },
): SpadeTalkCard {
  const pending = entry.outcome === undefined;
  const bot = entry.machine ? `${entry.bot} on ${entry.machine}` : entry.bot;
  const title = spadeContractTitle(entry.contract, names.title);
  const header = `${pending ? "Asking" : "Asked"} ${bot} for the ${title}`;
  const key = `${entry.job}:result`;
  const when = entry.answeredAt === undefined ? {} : { at: entry.answeredAt };
  const row = (text: string, tone: SpadeTalkTone): SpadeTalkRow => ({
    key,
    from: "other",
    text,
    tone,
    live: false,
    ...when,
  });
  switch (entry.outcome) {
    case undefined:
      return {
        header,
        pending,
        rows: [waitingRow(key, { self: "", other: entry.bot, otherPhrase: names.otherPhrase })],
      };
    case "returned":
      return { header, pending, rows: [row(entry.result || `${entry.bot} answered`, "settled")] };
    case "failed":
      return {
        header,
        pending,
        rows: [
          row(
            entry.result
              ? `${entry.bot} couldn't answer · ${entry.result}`
              : `${entry.bot} couldn't answer`,
            "failed",
          ),
        ],
      };
    case "stopped":
      return { header, pending, rows: [row(`Stopped before ${entry.bot} answered`, "quiet")] };
  }
}

/**
 * The receiver's card for a contract call it was given: "Quill asked for cheapest fare", its
 * input in one line, and what this bot returned (or that it is working on it).
 */
export function spadeContractAskedCard(
  asked: SpadeContractAsked,
  names: { from: string; self: string; working: boolean },
): SpadeTalkCard {
  const title = spadeContractTitle(asked.contract);
  const rows: SpadeTalkRow[] = [];
  if (asked.input)
    rows.push({ key: "input", from: "other", text: asked.input, tone: "quiet", live: false });
  if (asked.returned !== undefined)
    rows.push({
      key: "returned",
      from: "self",
      text: asked.returned || "Returned",
      tone: "settled",
      live: false,
    });
  else
    rows.push({
      key: "returned",
      from: "self",
      text: names.working ? `${names.self} is working on it` : `${names.self} hasn't answered`,
      tone: names.working ? "working" : "quiet",
      live: names.working,
    });
  return {
    header: `${names.from} asked for ${title}`,
    pending: asked.returned === undefined,
    rows,
  };
}
