import { SpadeRequestError, spadeUnanswered } from "./requests.ts";
import {
  parseSpadeConversations,
  parseSpadeCreated,
  parseSpadeEvents,
  type SpadeConversationRow,
} from "./wire.ts";

/*
 * Starting a conversation, safely when its answer is lost. Each start carries the client's own
 * key (`client_key`, a fresh UUID per start). Spade keeps it with the conversation it makes and
 * answers the same start again with that conversation (spade/docs/chat-core.md), so a start whose
 * answer never came is found by its key, or sent again with it, and never makes a second one.
 *
 * A Spade older than keys ignores the key and lists none, so nothing proves which start made a
 * conversation. A lost start there is never claimed: when a new conversation opens with its
 * message, or Spade is out of reach, it is `unknown`, and its words stay with the person with a
 * note, never sent again on their own. Only with no such conversation can the words go again.
 */

/** The way to Spade for a start: reads, the start itself, and waiting for the way back. */
export interface SpadeStartLink {
  /** A GET: Spade's text on 2xx; rejects otherwise. */
  read(path: string): Promise<string>;
  /** The start's POST: Spade's text on 2xx; rejects otherwise. */
  post(path: string, body: unknown): Promise<string>;
  /** Resolves true once Spade can be asked again, false when it stays out of reach. */
  back(): Promise<boolean>;
}

/**
 * `started`: the conversation is `id`. `unknown`: the answer was lost and Spade couldn't be
 * asked since; the conversation shows in Spade's list if it was made. Rejects when Spade
 * refused, or plainly didn't get it: then the message can be sent again.
 */
export type SpadeStartResult = { kind: "started"; id: string } | { kind: "unknown" };

/** New conversations looked into for this start's message, newest first. */
const lookAt = 5;

const startPath = "/v1/conversations";
const unknown: SpadeStartResult = { kind: "unknown" };

/** What the person sent, to know Spade's copy by: its words, and how many images came with them. */
export interface SpadeStartMessage {
  text: string;
  images: number;
}

/** `key`: this start's own client key, fresh for each start the person makes. */
export async function spadeStart(
  link: SpadeStartLink,
  body: Record<string, unknown>,
  message: SpadeStartMessage,
  key: string,
): Promise<SpadeStartResult> {
  // Read before the start goes, so nothing has been sent if this fails.
  const before = new Set((await list(link)).map((row) => row.id));
  const keyed = { ...body, client_key: key };
  let answer: string;
  try {
    answer = await link.post(startPath, keyed);
  } catch (error) {
    if (!spadeUnanswered(error)) throw error;
    return settle(link, { before, message, keyed, key });
  }
  return created(answer);
}

function created(answer: string): SpadeStartResult {
  const id = parseSpadeCreated(answer);
  if (!id)
    throw new SpadeRequestError("Spade started the conversation but didn't say where it is.");
  return { kind: "started", id };
}

interface Lost {
  before: ReadonlySet<string>;
  message: SpadeStartMessage;
  keyed: Record<string, unknown>;
  key: string;
}

/** The answer was lost: find what Spade made from this start, once it can be asked. */
async function settle(link: SpadeStartLink, lost: Lost): Promise<SpadeStartResult> {
  if (!(await link.back())) return unknown;
  let rows: SpadeConversationRow[];
  try {
    rows = await list(link);
  } catch {
    return unknown;
  }
  const mine = rows.find((row) => row.clientKey === lost.key);
  if (mine) return { kind: "started", id: mine.id };
  // A Spade that keeps keys and lists none of this one's: the start goes again with its key.
  if (rows.some((row) => row.clientKey !== undefined)) return again(link, lost.keyed);
  return byContent(link, rows, lost);
}

/**
 * The same start again, by its key: Spade answers with the conversation it made, or makes it now.
 * A refusal means Spade doesn't have it (a key it knows is answered before any check).
 */
async function again(
  link: SpadeStartLink,
  keyed: Record<string, unknown>,
): Promise<SpadeStartResult> {
  try {
    return created(await link.post(startPath, keyed));
  } catch (error) {
    if (spadeUnanswered(error)) return unknown;
    throw error;
  }
}

/**
 * A Spade older than keys: nothing proves which start made a conversation, so none is claimed.
 * A new one opening with this message may be this start's, or an identical one from elsewhere,
 * so the start is `unknown`; with none, Spade didn't get it and the words can go again.
 */
async function byContent(
  link: SpadeStartLink,
  rows: readonly SpadeConversationRow[],
  { before, message }: Lost,
): Promise<SpadeStartResult> {
  try {
    for (const row of rows.filter((entry) => !before.has(entry.id)).slice(0, lookAt)) {
      const first = await opening(link, row.id);
      if (first?.text === message.text.trim() && first.images === message.images) return unknown;
    }
  } catch {
    return unknown;
  }
  throw new SpadeRequestError("The connection dropped before Spade got the message.");
}

async function list(link: SpadeStartLink) {
  const rows = parseSpadeConversations(await link.read(startPath));
  if (!rows) throw new SpadeRequestError("Spade's conversation list didn't make sense.");
  return rows;
}

/** A conversation's first message: its words and how many images it carried. */
async function opening(
  link: SpadeStartLink,
  id: string,
): Promise<{ text: string; images: number } | undefined> {
  const events = parseSpadeEvents(
    await link.read(`/v1/conversations/${encodeURIComponent(id)}/events?after=0&limit=${lookAt}`),
  );
  const first = events?.find((stored) => stored.event.type === "user_message")?.event;
  return first?.type === "user_message"
    ? { text: first.text.trim(), images: first.images.length }
    : undefined;
}

/** The note a start's words keep while Spade may have them. */
export const spadeUnconfirmedNote =
  "Couldn't confirm Spade got this. Check Spade's list before sending it again.";

/**
 * What the composer does with a start's words once it ends: cleared only once it started; kept
 * when refused, to send again; kept with the note when unknown, for the person to decide.
 */
export function spadeStartWords(outcome: "started" | "refused" | "unknown"): {
  keep: boolean;
  note: string | undefined;
} {
  if (outcome === "started") return { keep: false, note: undefined };
  return { keep: true, note: outcome === "unknown" ? spadeUnconfirmedNote : undefined };
}
