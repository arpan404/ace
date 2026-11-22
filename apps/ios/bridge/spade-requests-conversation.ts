import { SpadeRequestError, parseSpadeEvents } from "@ace/ui-core/spade-chat";
import { z } from "zod";
import {
  SpadeDraftWire,
  spadeCardReply,
  spadeOpenCard,
  spadeRefusedAt,
} from "./spade-question-rows.ts";
import {
  readSpadeFile,
  readSpadeImage,
  SpadeAudioRequest,
  SpadeDocumentRequest,
  SpadeImageRequest,
} from "./spade-image.ts";
import {
  prepareSpadeSend,
  SpadeAttachmentsWire,
  spadeUploadMs,
  spadeWords,
  type SpadeOutgoing,
} from "./spade-attachments.ts";
import type { NativeAttachment } from "./native-attachment.ts";
import { setRunning } from "./spade-settings.ts";
import type { NativeSpade } from "./spade.ts";
import { segment } from "./spade-text.ts";
import {
  spadeConversationPath,
  spadeRefused,
  spadeRequestArea,
  type SpadeOutcome,
} from "./spade-requests-area.ts";

/*
 * A conversation with a bot: send a message, stop a reply, answer an approval or a card of
 * questions, read back what the live stream missed, open a picture, file or recording, turn
 * Spade on, and pin the bot.
 */

const conversationId = z.string().min(1).max(256);

/** A card of questions (ADR 0154): its drafts to answer it, Answer later, or Never mind. */
const SpadeQuestionRequest = z.object({
  type: z.literal("spade.question"),
  conversationId,
  callId: z.string().min(1).max(256),
  reply: z.union([
    z.object({ drafts: z.array(SpadeDraftWire).min(1).max(10) }),
    z.object({ defer: z.literal(true) }),
    z.object({ dismiss: z.literal(true) }),
  ]),
});

export const spadeConversationRequests = spadeRequestArea(
  [
    /** Words, files and a recording (`spade-attachments.ts`); words may be empty when it carries any. */
    z.object({
      type: z.literal("spade.send"),
      conversationId,
      text: z.string().trim().max(200_000),
      ...SpadeAttachmentsWire,
    }),
    z.object({ type: z.literal("spade.stop"), conversationId }),
    z.object({
      type: z.literal("spade.answer"),
      conversationId,
      callId: z.string().min(1).max(256),
      allowed: z.boolean(),
      always: z.boolean(),
    }),
    SpadeQuestionRequest,
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
    /** Pin a bot to the strip above the list, or unpin it: kept in Spade, so on every device. */
    z.object({
      type: z.literal("spade.pin"),
      agentId: z.string().min(1).max(256),
      pinned: z.boolean(),
    }),
    /** A picture in a conversation, by its hash, for its thumbnail or the full-screen viewer. */
    SpadeImageRequest,
    SpadeDocumentRequest,
    SpadeAudioRequest,
  ],
  async (
    { owner, spade, deps, ask, signal },
    request,
  ): Promise<SpadeOutcome | ({ ok: true } & NativeAttachment)> => {
    switch (request.type) {
      case "spade.send": {
        // Words alone show at once; a message carrying files waits until all of it is read.
        const prepared =
          request.files?.length || request.voice
            ? await prepareSpadeSend(request, deps.chunks, ask, signal)
            : spadeWords(request.text);
        if ("problem" in prepared)
          return { ok: false, title: "Couldn't send", message: prepared.problem };
        const length = JSON.stringify(prepared.body).length;
        return send(spade, request.conversationId, prepared, deps, () =>
          ask(
            "POST",
            `${spadeConversationPath(request.conversationId)}/messages`,
            prepared.body,
            spadeUploadMs(length),
          ),
        );
      }
      case "spade.stop":
        try {
          await ask("POST", `${spadeConversationPath(request.conversationId)}/stop`);
        } catch (error) {
          // 404: nothing was answering by the time Stop arrived, which is what Stop wanted.
          if (!(error instanceof SpadeRequestError && error.status === 404))
            return spadeRefused("Couldn't stop", error);
        }
        return { ok: true };
      case "spade.answer":
        try {
          await ask(
            "POST",
            `${spadeConversationPath(request.conversationId)}/approvals/${segment(request.callId)}`,
            {
              allowed: request.allowed,
              always: request.always,
            },
          );
          spade.refresh();
          return { ok: true };
        } catch (error) {
          return spadeRefused("Couldn't answer", error);
        }
      case "spade.question":
        return question(spade, request, (body) =>
          ask(
            "POST",
            `${spadeConversationPath(request.conversationId)}/questions/${segment(request.callId)}`,
            body,
          ),
        );
      case "spade.question.read":
        return readBack(spade, request.conversationId, (route) => ask("GET", route));
      case "spade.image":
        try {
          const image = await readSpadeImage(owner, deps.images, deps.id, request, signal);
          return { ok: true, ...image };
        } catch (error) {
          return spadeRefused("Couldn't show the image", error);
        }
      case "spade.document":
      case "spade.audio":
        try {
          return { ok: true, ...(await readSpadeFile(owner, deps.id, request, signal)) };
        } catch (error) {
          const what = request.type === "spade.audio" ? "the voice message" : request.name;
          return spadeRefused(`Couldn't open ${what}`, error);
        }
      case "spade.enable":
        return setRunning(owner, spade, true, signal);
      case "spade.pin":
        try {
          await ask("PUT", `/v1/agents/${segment(request.agentId)}/pin`, {
            pinned: request.pinned,
          });
          spade.refresh();
          return { ok: true };
        } catch (error) {
          return spadeRefused(request.pinned ? "Couldn't pin" : "Couldn't unpin", error);
        }
    }
  },
);

/**
 * A card's reply. Drafts are checked by the shared rules first, so a card that isn't ready yet
 * never reaches Spade and turns to the question that needs more; Spade checks again, and its
 * refusal names the question it means.
 */
async function question(
  spade: NativeSpade,
  request: z.infer<typeof SpadeQuestionRequest>,
  post: (body: unknown) => Promise<string>,
): Promise<SpadeOutcome> {
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
    const said = spadeRefused("", error);
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
): Promise<SpadeOutcome> {
  const follow = spade.follow(conversation);
  if (!follow) return { ok: true };
  try {
    for (;;) {
      const after = follow.lastSeq;
      const page = parseSpadeEvents(
        await read(`${spadeConversationPath(conversation)}/events?after=${after}&limit=200`),
      );
      if (!page) return { ok: false, title: "", message: "Couldn't read the conversation." };
      for (const stored of page) follow.apply({ kind: "stored", stored });
      if (page.length < 200 || follow.lastSeq === after) return { ok: true };
    }
  } catch (error) {
    return spadeRefused("Couldn't read the conversation", error);
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
  message: SpadeOutgoing,
  deps: { id(): string },
  post: () => Promise<string>,
): Promise<SpadeOutcome> {
  const follow = spade.follow(conversation);
  const key = `local-${deps.id()}`;
  const text = typeof message.body.text === "string" ? message.body.text : "";
  follow?.apply({
    kind: "sent",
    key,
    text,
    images: message.images,
    documents: message.documents,
    ...(message.voice ? { voice: message.voice } : {}),
  });
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
    return spadeRefused(bot ? `Couldn't send to ${bot}` : "Couldn't send", error);
  }
}
