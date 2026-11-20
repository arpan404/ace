import { spadeLiveAgent, type SpadeAnswer } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ConversationFollow, type FollowDeps } from "./conversation-follow.ts";
import { KeptFollows } from "./kept-follows.ts";
import type { SpadeMessage } from "./spade-attachments.ts";
import { segment, spadeBody, spadeHttp, SpadeRequestError } from "./spade-requests.ts";
import { agentsKey } from "./use-spade-roster.ts";
import { spadeTransport } from "./spade-transport.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { liveRowKey, usePublishLiveBot } from "./spade-live-rows.ts";

/** Bots' conversations opened lately, kept for opening again at once. */
const keptConversations = new KeptFollows<ConversationFollow>();

/** What a card posts: exactly one of these. */
export type QuestionReply =
  | { answers: readonly SpadeAnswer[] }
  | { defer: true }
  | { dismiss: true }
  /** A connect card: the person connected the app as this connector (ADR 0131, amendment 1). */
  | { connected: string; everyone: boolean };

export const followDeps: FollowDeps = {
  frame: (callback) =>
    typeof requestAnimationFrame === "function"
      ? void requestAnimationFrame(callback)
      : void setTimeout(callback, 16),
  later: (delay, callback) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

/**
 * One Spade conversation, live: what the person sees, and the requests that change it. Sending
 * always goes: while a reply is open the message steers it (Spade decides, never the client).
 */
export function useSpadeConversation(conversation: string) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const ready = useSpadeStatus()?.state === "ready";
  // Opened before, it shows at once as last seen and catches up from there.
  const [follow] = useState(() =>
    keptConversations.take(
      client,
      conversation,
      () => new ConversationFollow(spadeTransport(client), conversation, followDeps),
    ),
  );
  useEffect(() => {
    follow.start();
    return () => follow.stop();
  }, [follow]);
  useEffect(() => follow.setReady(ready), [follow, ready]);
  const side: Pick<ConversationFollow, "onSide" | "onEnded"> = follow;
  const snapshot = useSyncExternalStore(follow.subscribe, follow.get, follow.get);
  // The list row says what this chat shows, from the same view.
  const machine = useSpadeMachine().key;
  usePublishLiveBot(liveRowKey(machine, conversation), spadeLiveAgent(snapshot.view), [
    ...agentsKey,
    machine,
  ]);
  const path = `/v1/conversations/${segment(conversation)}`;
  const listChanged = () => void cache.invalidateQueries({ queryKey: agentsKey });

  return {
    ...snapshot,
    ready,
    /** Frames the stream carries beside the conversation (`onSide`); the same object always. */
    side,
    retry: () => follow.retry(),
    /** Resolves false when Spade refused it; the message leaves the conversation then. */
    async send(message: SpadeMessage): Promise<void> {
      const key = `local-${crypto.randomUUID()}`;
      const { text, images } = message;
      follow.apply({
        kind: "sent",
        key,
        text,
        images: images.map((image) => image.ref),
        documents: (message.documents ?? []).map((document) => document.ref),
        ...(message.voice ? { voice: message.voice.ref } : {}),
      });
      try {
        await spadeHttp(client, "POST", `${path}/messages`, { body: spadeBody(message) });
        listChanged();
      } catch (error) {
        // No answer came back: Spade may have the message. It shows once it arrives; only a
        // message Spade never stored comes back to the composer.
        if (error instanceof SpadeRequestError && error.unanswered && (await follow.reached(key))) {
          listChanged();
          return;
        }
        follow.apply({ kind: "refused", key });
        throw error;
      }
    },
    /**
     * Try again on the last reply, which failed: Spade answers the same turn again in its place,
     * so nothing is posted twice and the failure gives way to the new reply.
     */
    async tryAgain(reply: string): Promise<void> {
      await spadeHttp(client, "POST", `${path}/retry`, { body: { reply } });
      listChanged();
    },
    async stop(): Promise<void> {
      try {
        await spadeHttp(client, "POST", `${path}/stop`);
      } catch (error) {
        // 404: nothing was answering by the time Stop arrived, which is what Stop wanted.
        if (!(error instanceof SpadeRequestError && error.status === 404)) throw error;
      }
    },
    answer(callId: string, allowed: boolean, always: boolean): Promise<string> {
      return spadeHttp(client, "POST", `${path}/approvals/${segment(callId)}`, {
        body: { allowed, always },
      });
    },
    /** A plugin asking to run outside the sandbox (ADR 0167): `always` keeps it for its version. */
    answerOutside(id: string, allowed: boolean, always: boolean): Promise<string> {
      return spadeHttp(client, "POST", `${path}/plugin_outside/${segment(id)}`, {
        body: { allowed, always },
      });
    },
    /**
     * A card of questions (ADR 0154): its answers, Answer later, or Never mind. A 400 names the
     * question and the rule it broke, in Spade's words (`SpadeRequestError`'s message).
     */
    question(callId: string, body: QuestionReply): Promise<string> {
      const card = `${path}/questions/${segment(callId)}`;
      if ("connected" in body)
        return spadeHttp(client, "POST", `${card}/connected`, {
          body: { connector: body.connected, everyone: body.everyone },
        });
      return spadeHttp(client, "POST", card, { body });
    },
  };
}

export type SpadeConversation = ReturnType<typeof useSpadeConversation>;
