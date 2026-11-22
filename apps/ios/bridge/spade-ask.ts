import {
  parseSpadeAgents,
  parseSpadeEvents,
  parseSpadeMain,
  type SpadeHostRecord,
  type SpadeStored,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import type { NativeSpade } from "./spade.ts";
import { segment } from "./spade-text.ts";

/*
 * Siri's Ask Spade on one machine (ADR 0134, amendment 2026-11-22). Swift asks every reachable
 * machine where Spade lives (`spade.main.read`), elects the host as the Spade tab does, then
 * sends there (`spade.ask`) and waits a while for the reply that answers the words; past Siri's
 * time it waits again (`spade.reply`) for the notification. Spade's message route answers 202
 * and nothing more, so the reply is found in the conversation's events after the person's
 * message: the first reply started after it, and its end.
 */

const conversationId = z.string().min(1).max(256);
/** The longest one wait holds a request open: Siri's limit is shorter, iOS's background time longer. */
const waitMost = 25_000;
/** How often the events are read while waiting. */
const readEvery = 500;

const asked = {
  conversationId,
  /** Events up to here came before the question: from `spade.main.read`. */
  after: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(20_000),
  waitMs: z.number().int().min(0).max(waitMost),
};

export const spadeAskRequests = [
  z.object({ type: z.literal("spade.main.read") }),
  z.object({ type: z.literal("spade.ask"), ...asked }),
  z.object({ type: z.literal("spade.reply"), ...asked }),
] as const;
export type NativeSpadeAskRequest = z.infer<(typeof spadeAskRequests)[number]>;

type Refusal = { ok: false; title: string; message: string };
export type SpadeAskAnswer =
  | Refusal
  | {
      ok: true;
      /** This machine's ace host id, as host records name it. */
      here: string | null;
      /** The host choice this machine holds; null for none. */
      record: SpadeHostRecord | null;
      /** The main Spade's conversation on this machine. */
      conversationId: string;
      createdAt: number;
      /** The conversation's last event the list knows of: where a question's events begin. */
      after: number;
    }
  /** The reply's words; null while it is still coming. */
  | { ok: true; reply: string | null };

type Ask = (method: "GET" | "POST", route: string, body?: unknown) => Promise<string>;

const refused = (title: string, error: unknown): Refusal => ({
  ok: false,
  title,
  message: (error instanceof Error && error.message) || "Try again.",
});

export async function answerSpadeAsk(
  spade: NativeSpade,
  request: NativeSpadeAskRequest,
  ask: Ask,
  now: () => number,
  signal: AbortSignal,
): Promise<SpadeAskAnswer> {
  if (request.type === "spade.main.read") return readMain(spade, ask);
  const route = `/v1/conversations/${segment(request.conversationId)}`;
  if (request.type === "spade.ask") {
    try {
      await ask("POST", `${route}/messages`, { text: request.text });
    } catch (error) {
      return refused("Couldn't send to Spade", error);
    }
    spade.refresh();
  }
  const deadline = now() + request.waitMs;
  let after = request.after;
  const seen: SpadeStored[] = [];
  for (;;) {
    try {
      const page = parseSpadeEvents(await ask("GET", `${route}/events?after=${after}&limit=200`));
      if (!page) return { ok: false, title: "", message: "Spade's answer didn't make sense." };
      seen.push(...page);
      after = page.at(-1)?.seq ?? after;
      // A full page: there is more to read before waiting.
      if (page.length === 200) continue;
    } catch (error) {
      return refused("Couldn't read Spade's reply", error);
    }
    const found = spadeAnswerTo(request.text, seen);
    if (found.kind === "replied") return { ok: true, reply: found.text };
    if (found.kind === "failed") return { ok: false, title: "", message: found.message };
    if (signal.aborted || now() + readEvery > deadline) return { ok: true, reply: null };
    await spade.pause(readEvery);
  }
}

async function readMain(spade: NativeSpade, ask: Ask): Promise<SpadeAskAnswer> {
  const { status } = spade.setting;
  if (status && status.state !== "ready")
    return { ok: false, title: "", message: spade.placeSentence };
  try {
    const [mainBody, agentsBody] = await Promise.all([
      ask("GET", "/v1/main"),
      ask("GET", "/v1/agents"),
    ]);
    const main = parseSpadeMain(mainBody);
    const bot = parseSpadeAgents(agentsBody)?.find((agent) => agent.kind === "main");
    if (!main || !bot)
      return { ok: false, title: "", message: "Spade isn't set up on this machine." };
    if (main.off)
      return { ok: false, title: "", message: "Spade is switched off on this machine." };
    return {
      ok: true,
      here: main.here ?? null,
      record: main.host ?? null,
      conversationId: bot.conversation,
      createdAt: bot.createdAt,
      after: Math.max(bot.lastMessage?.seq ?? 0, bot.seenSeq ?? 0),
    };
  } catch (error) {
    return refused("Couldn't reach Spade", error);
  }
}

type Found =
  | { kind: "waiting" }
  | { kind: "replied"; text: string }
  | { kind: "failed"; message: string };

/**
 * The reply that answers `text` among the events after the question was asked: the person's
 * message with those words, then the first reply started after it, then that reply's end. A reply
 * already open when the message landed belongs to an earlier message. Pure.
 */
export function spadeAnswerTo(text: string, events: readonly SpadeStored[]): Found {
  const words = text.trim();
  const question = events.findIndex(
    ({ event }) =>
      event.type === "user_message" && event.text.trim() === words && !event.from_agent,
  );
  if (question < 0) return { kind: "waiting" };
  let reply: string | undefined;
  for (const { event } of events.slice(question + 1)) {
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
