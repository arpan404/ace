import {
  parseSpadeAgents,
  parseSpadeEvents,
  parseSpadeMain,
  SpadeRequestError,
  type SpadeHostRecord,
  type SpadeStored,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import {
  spadeConversationPath,
  spadeRefused,
  spadeRequestArea,
  type SpadeAsk,
  type SpadeRefusal,
} from "./spade-requests-area.ts";
import type { NativeSpade } from "./spade.ts";

/*
 * Siri's Ask Spade on one machine (ADR 0134, amendment 2026-11-22). Swift asks every reachable
 * machine where Spade lives (`spade.main.read`), elects the host as the Spade tab does, then
 * sends there (`spade.ask`) and waits a while for the reply; past Siri's time it waits again
 * (`spade.reply`) for the notification. Spade's message route answers 202 and nothing more, so
 * the message is found in the conversation's events: the first of the person's with those words
 * after where the question began that no earlier ask here claimed. Its event's seq is what the
 * reply is waited on by: the first reply started after it, and that reply's end.
 */

const conversationId = z.string().min(1).max(256);
const seq = z.number().int().nonnegative();
/** The longest one wait holds a request open: Siri's limit is shorter, iOS's background time longer. */
const waitMost = 25_000;
const waitFor = z.number().int().min(0).max(waitMost);
/** How often the events are read while waiting. */
const readEvery = 500;
const page = 200;

export const spadeAskRequests = spadeRequestArea(
  [
    z.object({ type: z.literal("spade.main.read") }),
    z.object({
      type: z.literal("spade.ask"),
      conversationId,
      /** Events up to here came before the question: from `spade.main.read`. */
      after: seq,
      text: z.string().trim().min(1).max(20_000),
      waitMs: waitFor,
    }),
    /** The asked message's event, from `spade.ask`: wait on for the reply to it. */
    z.object({ type: z.literal("spade.reply"), conversationId, asked: seq, waitMs: waitFor }),
  ],
  ({ spade, ask, deps, signal }, request): Promise<SpadeAskAnswer> => {
    const wait = { spade, ask, now: deps.now, signal };
    switch (request.type) {
      case "spade.main.read":
        return readMain(spade, ask);
      case "spade.ask":
        return askSpade(wait, request);
      case "spade.reply":
        return replyTo(wait, request.conversationId, request.asked, request.waitMs);
    }
  },
);

export type SpadeAskAnswer =
  | SpadeRefusal
  | {
      ok: true;
      /** This machine's ace host id, as host records name it. */
      here: string | null;
      /** The host choice this machine holds, whether or not its own Spade can answer; null for none. */
      record: SpadeHostRecord | null;
      /** The main Spade's conversation here; null when this machine's Spade can't take words. */
      conversationId: string | null;
      /** Why it can't, in a sentence, when `conversationId` is null. */
      problem: string | null;
      createdAt: number;
      /** The conversation's last event the list knows of: where a question's events begin. */
      after: number;
    }
  | {
      ok: true;
      /** The asked message's event; null when the send's answer was lost and it isn't seen yet. */
      asked: number | null;
      /** The reply's words; null while it is still coming. */
      reply: string | null;
    };

interface Waiting {
  spade: NativeSpade;
  ask: SpadeAsk;
  now(): number;
  signal: AbortSignal;
}

async function readMain(spade: NativeSpade, ask: SpadeAsk): Promise<SpadeAskAnswer> {
  const { status } = spade.setting;
  if (status && status.state !== "ready")
    return { ok: false, title: "", message: spade.placeSentence };
  let main: ReturnType<typeof parseSpadeMain>;
  try {
    main = parseSpadeMain(await ask("GET", "/v1/main"));
  } catch (error) {
    return spadeRefused("Couldn't reach Spade", error);
  }
  if (!main) return { ok: false, title: "", message: "Spade's answer didn't make sense." };
  // The host choice stands on its own: a machine whose Spade lists no main bot still says where
  // the fleet chose, so Siri never sends to a machine that hasn't heard of the choice.
  const where = { here: main.here ?? null, record: main.host ?? null };
  const cannot = (problem: string) =>
    ({ ok: true, ...where, conversationId: null, problem, createdAt: 0, after: 0 }) as const;
  if (main.off) return cannot("Spade is switched off on its computer.");
  const bot = await ask("GET", "/v1/agents").then(
    (body) => parseSpadeAgents(body)?.find((agent) => agent.kind === "main"),
    () => undefined,
  );
  if (!bot) return cannot("Spade isn't answering on its computer right now.");
  return {
    ok: true,
    ...where,
    conversationId: bot.conversation,
    problem: null,
    createdAt: bot.createdAt,
    after: Math.max(bot.lastMessage?.seq ?? 0, bot.seenSeq ?? 0),
  };
}

async function askSpade(
  wait: Waiting,
  request: { conversationId: string; after: number; text: string; waitMs: number },
): Promise<SpadeAskAnswer> {
  const route = spadeConversationPath(request.conversationId);
  try {
    await wait.ask("POST", `${route}/messages`, { text: request.text });
  } catch (error) {
    // No answer came back: Spade may have it. It is looked for like an accepted one.
    if (!(error instanceof SpadeRequestError && error.unanswered))
      return spadeRefused("Couldn't send to Spade", error);
  }
  wait.spade.refresh();
  const deadline = wait.now() + request.waitMs;
  const claims = wait.spade.askClaims;
  let after = request.after;
  for (;;) {
    const read = await readPage(wait.ask, route, after);
    if ("ok" in read) return read;
    const asked = spadeAskedIn(request.text, read, (at) => claims.has(claimKey(route, at)));
    if (asked !== undefined) {
      claims.add(claimKey(route, asked));
      return replyTo(wait, request.conversationId, asked, Math.max(0, deadline - wait.now()));
    }
    after = read.at(-1)?.seq ?? after;
    if (wait.signal.aborted || wait.now() + readEvery > deadline)
      return { ok: true, asked: null, reply: null };
    if (read.length < page) await wait.spade.pause(readEvery);
  }
}

async function replyTo(
  wait: Waiting,
  conversation: string,
  asked: number,
  waitMs: number,
): Promise<SpadeAskAnswer> {
  const route = spadeConversationPath(conversation);
  const deadline = wait.now() + waitMs;
  const seen: SpadeStored[] = [];
  let after = asked;
  for (;;) {
    const read = await readPage(wait.ask, route, after);
    if ("ok" in read) return read;
    seen.push(...read);
    after = read.at(-1)?.seq ?? after;
    // A full page: there is more to read before waiting.
    if (read.length === page) continue;
    const found = spadeReplyAfter(asked, seen);
    if (found.kind === "replied") return { ok: true, asked, reply: found.text };
    if (found.kind === "failed") return { ok: false, title: "", message: found.message };
    if (wait.signal.aborted || wait.now() + readEvery > deadline)
      return { ok: true, asked, reply: null };
    await wait.spade.pause(readEvery);
  }
}

async function readPage(
  ask: SpadeAsk,
  route: string,
  after: number,
): Promise<SpadeStored[] | SpadeRefusal> {
  try {
    const read = parseSpadeEvents(await ask("GET", `${route}/events?after=${after}&limit=${page}`));
    return read ?? { ok: false, title: "", message: "Spade's answer didn't make sense." };
  } catch (error) {
    return spadeRefused("Couldn't read Spade's reply", error);
  }
}

const claimKey = (route: string, at: number) => `${route}#${at}`;

/**
 * The seq of the person's message with `text` among `events`, skipping any `claimed` by an
 * earlier ask: two asks with the same words each take their own message. Pure.
 */
export function spadeAskedIn(
  text: string,
  events: readonly SpadeStored[],
  claimed: (seq: number) => boolean,
): number | undefined {
  const words = text.trim();
  return events.find(
    ({ seq: at, event }) =>
      event.type === "user_message" &&
      !event.from_agent &&
      event.text.trim() === words &&
      !claimed(at),
  )?.seq;
}

type Found =
  | { kind: "waiting" }
  | { kind: "replied"; text: string }
  | { kind: "failed"; message: string };

/**
 * The reply to the message at `asked`: the first reply started after that event, then that
 * reply's end. A reply already open when the message landed belongs to an earlier one. Pure.
 */
export function spadeReplyAfter(asked: number, events: readonly SpadeStored[]): Found {
  let reply: string | undefined;
  for (const { seq: at, event } of events) {
    if (at <= asked) continue;
    if (event.type === "reply_started" && reply === undefined) reply = event.reply;
    if (event.type === "unknown" || !("reply" in event) || event.reply !== reply) continue;
    if (
      event.type === "reply_finished" ||
      event.type === "reply_stopped" ||
      event.type === "reply_interrupted"
    )
      return { kind: "replied", text: event.text };
    if (event.type === "reply_failed")
      return { kind: "failed", message: event.error || "Spade couldn't answer." };
  }
  return { kind: "waiting" };
}
