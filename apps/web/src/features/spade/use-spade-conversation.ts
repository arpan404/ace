import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ConversationFollow, type FollowDeps } from "./conversation-follow.ts";
import type { SpadeMessage } from "./spade-attachments.ts";
import { segment, spadeBody, spadeHttp, SpadeRequestError } from "./spade-requests.ts";
import { agentsKey } from "./use-spade-roster.ts";
import { spadeTransport } from "./spade-transport.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useSpadeClient } from "./spade-machine.tsx";

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
  const [follow] = useState(
    () => new ConversationFollow(spadeTransport(client), conversation, followDeps),
  );
  useEffect(() => {
    follow.start();
    return () => follow.stop();
  }, [follow]);
  useEffect(() => follow.setReady(ready), [follow, ready]);
  const side: Pick<ConversationFollow, "onSide" | "onEnded"> = follow;
  const snapshot = useSyncExternalStore(follow.subscribe, follow.get, follow.get);
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
  };
}

export type SpadeConversation = ReturnType<typeof useSpadeConversation>;
