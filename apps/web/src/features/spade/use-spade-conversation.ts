import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  SpadeConversationFollow,
  spadeStopAnswered,
  type SpadeFollowDeps,
} from "@ace/ui-core/spade-chat";
import type { SpadeMessage } from "./spade-images.ts";
import { followLink, segment, spadeBody, spadeHttp } from "./spade-requests.ts";
import { conversationsKey } from "./use-spade-conversations.ts";
import { spadeTransport } from "./spade-transport.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

const deps: SpadeFollowDeps = {
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
  const client = useClient();
  const cache = useQueryClient();
  const ready = useSpadeStatus()?.state === "ready";
  const [follow] = useState(
    () => new SpadeConversationFollow(followLink(spadeTransport(client)), conversation, deps),
  );
  useEffect(() => {
    follow.start();
    return () => follow.stop();
  }, [follow]);
  useEffect(() => follow.setReady(ready), [follow, ready]);
  const snapshot = useSyncExternalStore(follow.subscribe, follow.get, follow.get);
  const path = `/v1/conversations/${segment(conversation)}`;
  const listChanged = () => void cache.invalidateQueries({ queryKey: conversationsKey });

  return {
    ...snapshot,
    ready,
    retry: () => follow.retry(),
    /** Resolves false when Spade refused it; the message leaves the conversation then. */
    async send(message: SpadeMessage): Promise<void> {
      const { text, images } = message;
      await follow.send(
        { key: `local-${crypto.randomUUID()}`, text, images: images.map((image) => image.ref) },
        () => spadeHttp(client, "POST", `${path}/messages`, { body: spadeBody(message) }),
      );
      listChanged();
    },
    async stop(): Promise<void> {
      try {
        await spadeHttp(client, "POST", `${path}/stop`);
      } catch (error) {
        if (!spadeStopAnswered(error)) throw error;
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
