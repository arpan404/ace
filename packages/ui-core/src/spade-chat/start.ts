import { SpadeRequestError, spadeUnanswered } from "./requests.ts";
import { parseSpadeConversations, parseSpadeCreated, parseSpadeEvents } from "./wire.ts";

/*
 * Starting a conversation, safely when its answer is lost. Spade's start takes no key a client
 * could look it up by later (`POST /v1/conversations {text}`), so a start whose answer never
 * came is settled by what Spade lists: a conversation that wasn't there before and opens with
 * this message is the one it made. Only a start Spade clearly doesn't have goes back to the
 * composer, so trying again never makes a second conversation.
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

export async function spadeStart(
  link: SpadeStartLink,
  body: unknown,
  text: string,
): Promise<SpadeStartResult> {
  // Read before the start goes, so nothing has been sent if this fails.
  const before = new Set((await list(link)).map((row) => row.id));
  let answer: string;
  try {
    answer = await link.post("/v1/conversations", body);
  } catch (error) {
    if (!spadeUnanswered(error)) throw error;
    return settle(link, before, text);
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
  text: string,
): Promise<SpadeStartResult> {
  if (!(await link.back())) return { kind: "unknown" };
  try {
    const fresh = (await list(link)).filter((row) => !before.has(row.id)).slice(0, lookAt);
    for (const row of fresh)
      if ((await opening(link, row.id)) === text.trim()) return { kind: "started", id: row.id };
  } catch {
    return { kind: "unknown" };
  }
  throw new SpadeRequestError("The connection dropped before Spade got the message.");
}

async function list(link: SpadeStartLink) {
  const rows = parseSpadeConversations(await link.read("/v1/conversations"));
  if (!rows) throw new SpadeRequestError("Spade's conversation list didn't make sense.");
  return rows;
}

/** A conversation's first message, as the person wrote it. */
async function opening(link: SpadeStartLink, id: string): Promise<string | undefined> {
  const events = parseSpadeEvents(
    await link.read(`/v1/conversations/${encodeURIComponent(id)}/events?after=0&limit=${lookAt}`),
  );
  const first = events?.find((stored) => stored.event.type === "user_message")?.event;
  return first?.type === "user_message" ? first.text.trim() : undefined;
}
