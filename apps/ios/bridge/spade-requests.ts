import type { ClientCore } from "@ace/client";
import {
  SpadeRequestError,
  parseSpadeAgent,
  parseSpadeEvents,
  spadeAgentTaskMax,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import {
  SpadeDraftWire,
  spadeCardReply,
  spadeOpenCard,
  spadeRefusedAt,
} from "./spade-question-rows.ts";
import { spadeProfile, type SpadeProfileRow } from "./spade-profile.ts";
import { segment, spadeText, type NativeSpade } from "./spade.ts";

/*
 * What the iPhone asks of Spade with an outcome it waits on: send a message, stop a reply,
 * answer an approval or a card of questions, turn Spade on. Every answer is `{ok: true}` or
 * `{ok: false, title, message}` in the person's words; a card's also says which question
 * (`at`) needs more.
 */

const conversationId = z.string().min(1).max(256);

export const NativeSpadeRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("spade.send"),
    conversationId,
    text: z.string().trim().min(1).max(200_000),
  }),
  z.object({ type: z.literal("spade.stop"), conversationId }),
  z.object({
    type: z.literal("spade.answer"),
    conversationId,
    callId: z.string().min(1).max(256),
    allowed: z.boolean(),
    always: z.boolean(),
  }),
  /** A card of questions (ADR 0154): its drafts to answer it, Answer later, or Never mind. */
  z.object({
    type: z.literal("spade.question"),
    conversationId,
    callId: z.string().min(1).max(256),
    reply: z.union([
      z.object({ drafts: z.array(SpadeDraftWire).min(1).max(10) }),
      z.object({ defer: z.literal(true) }),
      z.object({ dismiss: z.literal(true) }),
    ]),
  }),
  /**
   * A sent card still not settled a while on: read the conversation's events since the last one
   * shown, so an update the live stream missed still arrives.
   */
  z.object({
    type: z.literal("spade.question.read"),
    conversationId,
    callId: z.string().min(1).max(256),
  }),
  z.object({ type: z.literal("spade.enable") }),
  /** A message the person posts to a group (ADR 0132): it starts a run its lead answers. */
  z.object({
    type: z.literal("spade.group.send"),
    groupId: z.string().min(1).max(256),
    conversationId,
    text: z.string().trim().min(1).max(200_000),
  }),
  /** Stop ends the group's run: every ask still open, on every machine. */
  z.object({ type: z.literal("spade.group.stop"), groupId: z.string().min(1).max(256) }),
  /** A bot's profile, read afresh each time its sheet opens or is pulled. */
  z.object({ type: z.literal("spade.profile"), agentId: z.string().min(1).max(256) }),
  /** The bot's task, as the person wrote it on its profile. */
  z.object({
    type: z.literal("spade.task"),
    agentId: z.string().min(1).max(256),
    task: z.string().max(spadeAgentTaskMax),
  }),
]);
export type NativeSpadeRequest = z.infer<typeof NativeSpadeRequest>;

type Refusal = { ok: false; title: string; message: string; at?: number };
type Outcome = { ok: true } | Refusal;
type Answer = Outcome | { ok: true; profile: SpadeProfileRow };

const path = (id: string) => `/v1/conversations/${segment(id)}`;
const refused = (title: string, error: unknown): Refusal => ({
  ok: false,
  title,
  message: (error instanceof Error && error.message) || "Try again.",
});

export async function answerSpade(
  owner: ClientCore,
  spade: NativeSpade,
  request: NativeSpadeRequest,
  deps: { id(): string; now(): number },
  signal: AbortSignal,
): Promise<Answer> {
  const ask = (method: "GET" | "POST" | "PUT" | "PATCH", route: string, body?: unknown) =>
    spadeText(owner, deps.id, method, route, body, signal);
  switch (request.type) {
    case "spade.send":
      return send(spade, request.conversationId, request.text, deps, () =>
        ask("POST", `${path(request.conversationId)}/messages`, { text: request.text }),
      );
    case "spade.stop":
      try {
        await ask("POST", `${path(request.conversationId)}/stop`);
      } catch (error) {
        // 404: nothing was answering by the time Stop arrived, which is what Stop wanted.
        if (!(error instanceof SpadeRequestError && error.status === 404))
          return refused("Couldn't stop", error);
      }
      return { ok: true };
    case "spade.answer":
      try {
        await ask("POST", `${path(request.conversationId)}/approvals/${segment(request.callId)}`, {
          allowed: request.allowed,
          always: request.always,
        });
        spade.refresh();
        return { ok: true };
      } catch (error) {
        return refused("Couldn't answer", error);
      }
    case "spade.question":
      return question(spade, request, (body) =>
        ask("POST", `${path(request.conversationId)}/questions/${segment(request.callId)}`, body),
      );
    case "spade.question.read":
      return readBack(spade, request.conversationId, (route) => ask("GET", route));
    case "spade.enable":
      return enable(owner, spade, signal);
    case "spade.group.send":
      return sendToGroup(spade, request, deps, () =>
        ask("POST", `/v1/groups/${segment(request.groupId)}/messages`, { text: request.text }),
      );
    case "spade.group.stop":
      try {
        await ask("POST", `/v1/groups/${segment(request.groupId)}/stop`);
      } catch (error) {
        // 404: nothing was running by the time Stop arrived, which is what Stop wanted.
        if (!(error instanceof SpadeRequestError && error.status === 404))
          return refused("Couldn't stop", error);
      }
      spade.refresh();
      return { ok: true };
    case "spade.profile": {
      const bot = spade.bot(request.agentId);
      if (!bot) return { ok: false, title: "", message: "Spade hasn't listed this bot yet." };
      const profile = await spadeProfile(
        bot,
        spade.machineName,
        (route) => ask("GET", route),
        deps.now(),
      );
      return { ok: true, profile };
    }
    case "spade.task":
      try {
        const task = request.task.trim();
        const body = await ask("PATCH", `/v1/agents/${segment(request.agentId)}`, { task });
        // The write says what Spade now holds: the profile opened next shows it at once, not the
        // list as last read while the refresh is still on its way.
        spade.saved(parseSpadeAgent(body) ?? { id: request.agentId, task });
        spade.refresh();
        return { ok: true };
      } catch (error) {
        return refused("Couldn't save the task", error);
      }
  }
}

/**
 * A card's reply. Drafts are checked by the shared rules first, so a card that isn't ready yet
 * never reaches Spade and turns to the question that needs more; Spade checks again, and its
 * refusal names the question it means.
 */
async function question(
  spade: NativeSpade,
  request: Extract<NativeSpadeRequest, { type: "spade.question" }>,
  post: (body: unknown) => Promise<string>,
): Promise<Outcome> {
  const card = spade.follow(request.conversationId)?.get().view;
  const open = card && spadeOpenCard(card, request.callId);
  let body: unknown = request.reply;
  if ("drafts" in request.reply) {
    if (!open) return { ok: false, title: "", message: "That question isn't open any more." };
    const read = spadeCardReply(open, request.reply.drafts);
    if ("missing" in read) return { ok: false, title: "", message: read.missing, at: read.at };
    body = { answers: read.answers };
  }
  try {
    await post(body);
    spade.refresh();
    return { ok: true };
  } catch (error) {
    const said = refused("", error);
    const at = open ? spadeRefusedAt(open, said.message) : undefined;
    return at === undefined ? said : { ...said, at };
  }
}

/**
 * The open conversation's events after the last one shown, folded in. Not open, there is nothing
 * to correct: it is read afresh when it opens.
 */
async function readBack(
  spade: NativeSpade,
  conversation: string,
  read: (route: string) => Promise<string>,
): Promise<Outcome> {
  const follow = spade.follow(conversation);
  if (!follow) return { ok: true };
  try {
    for (;;) {
      const after = follow.lastSeq;
      const page = parseSpadeEvents(
        await read(`${path(conversation)}/events?after=${after}&limit=200`),
      );
      if (!page) return { ok: false, title: "", message: "Couldn't read the conversation." };
      for (const stored of page) follow.apply({ kind: "stored", stored });
      if (page.length < 200 || follow.lastSeq === after) return { ok: true };
    }
  } catch (error) {
    return refused("Couldn't read the conversation", error);
  }
}

/**
 * The message shows at once in the open conversation. When no answer came back Spade may have
 * it: it stays once Spade's copy arrives, and only a message Spade never stored is refused, so
 * its words go back to the composer.
 */
async function send(
  spade: NativeSpade,
  conversation: string,
  text: string,
  deps: { id(): string },
  post: () => Promise<string>,
): Promise<Outcome> {
  const follow = spade.follow(conversation);
  const key = `local-${deps.id()}`;
  follow?.apply({ kind: "sent", key, text, images: [], documents: [] });
  try {
    await post();
    spade.refresh();
    return { ok: true };
  } catch (error) {
    if (
      follow &&
      error instanceof SpadeRequestError &&
      error.unanswered &&
      (await follow.reached(key))
    ) {
      spade.refresh();
      return { ok: true };
    }
    follow?.apply({ kind: "refused", key });
    const bot = spade.botName(conversation);
    return refused(bot ? `Couldn't send to ${bot}` : "Couldn't send", error);
  }
}

/**
 * A post to a group shows at once, as a bot's message does; one Spade never stored is refused,
 * so its words go back to the composer.
 */
async function sendToGroup(
  spade: NativeSpade,
  request: Extract<NativeSpadeRequest, { type: "spade.group.send" }>,
  deps: { id(): string },
  post: () => Promise<string>,
): Promise<Outcome> {
  const follow = spade.groupFollow(request.conversationId);
  const key = `local-${deps.id()}`;
  follow?.apply({ kind: "sent", key, text: request.text, images: [], documents: [] });
  try {
    await post();
    spade.refresh();
    return { ok: true };
  } catch (error) {
    if (
      follow &&
      error instanceof SpadeRequestError &&
      error.unanswered &&
      (await follow.reached(key))
    ) {
      spade.refresh();
      return { ok: true };
    }
    follow?.apply({ kind: "refused", key });
    const name = spade.groupName(request.groupId);
    return refused(name ? `Couldn't send to ${name}` : "Couldn't send", error);
  }
}

/** `spade.enabled` is global and admin only: a device without admin is told so. */
async function enable(owner: ClientCore, spade: NativeSpade, signal: AbortSignal) {
  const reply = await owner
    .request(
      { type: "settings.set", key: "spade.enabled", value: true, layer: { kind: "global" } },
      { signal, timeoutMs: 10_000 },
    )
    .catch(() => undefined);
  spade.refresh();
  if (reply?.ok) return { ok: true } as const;
  return {
    ok: false,
    title: "Couldn't turn on Spade",
    message: "Only a device with admin access to this machine can change it.",
  } as const;
}
