import { SpadeRequestError, spadeUnanswered } from "./requests.ts";
import { parseSpadeConversations, parseSpadeCreated, parseSpadeEvents } from "./wire.ts";

/*
 * Starting a conversation, safely when its answer is lost. Spade's start takes no key a client
 * could look it up by later (`POST /v1/conversations {text}`), so a start whose answer never
 * came is settled by what Spade lists: the one conversation that wasn't there before and opens
 * with this message is the one it made. When that can't be told for sure (two match, images
 * can't be compared, Spade is out of reach) the start is `unknown`: its words stay with the person
 * with a note, never sent again on their own, and never cleared.
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

/** What the person sent, to know Spade's copy by: its words, and how many images came with them. */
export interface SpadeStartMessage {
  text: string;
  images: number;
}

export async function spadeStart(
  link: SpadeStartLink,
  body: unknown,
  message: SpadeStartMessage,
): Promise<SpadeStartResult> {
  // Read before the start goes, so nothing has been sent if this fails.
  const before = new Set((await list(link)).map((row) => row.id));
  let answer: string;
  try {
    answer = await link.post("/v1/conversations", body);
  } catch (error) {
    if (!spadeUnanswered(error)) throw error;
    return settle(link, before, message);
  }
  const id = parseSpadeCreated(answer);
  if (!id)
    throw new SpadeRequestError("Spade started the conversation but didn't say where it is.");
  return { kind: "started", id };
}

/** The answer was lost: find what Spade made from this start, once it can be asked. */
async function settle(
  link: SpadeStartLink,
  before: ReadonlySet<string>,
  message: SpadeStartMessage,
): Promise<SpadeStartResult> {
  if (!(await link.back())) return { kind: "unknown" };
  const matches: string[] = [];
  try {
    const fresh = (await list(link)).filter((row) => !before.has(row.id)).slice(0, lookAt);
    for (const row of fresh) {
      const first = await opening(link, row.id);
      if (first?.text === message.text.trim() && first.images === message.images)
        matches.push(row.id);
    }
  } catch {
    return { kind: "unknown" };
  }
  const [only, ...others] = matches;
  if (only === undefined)
    throw new SpadeRequestError("The connection dropped before Spade got the message.");
  // Two alike, or images Spade stores by hash and this side holds as bytes: not for sure ours.
  if (others.length || message.images > 0) return { kind: "unknown" };
  return { kind: "started", id: only };
}

async function list(link: SpadeStartLink) {
  const rows = parseSpadeConversations(await link.read("/v1/conversations"));
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
