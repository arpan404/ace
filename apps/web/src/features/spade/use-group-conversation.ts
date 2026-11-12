import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { GroupFollow } from "./conversation-follow.ts";
import type { SpadeMessage } from "./spade-attachments.ts";
import { SpadeRequestError } from "./spade-requests.ts";
import { postGroupMessage, stopGroup } from "./spade-teams-api.ts";
import { spadeTransport } from "./spade-transport.ts";
import { followDeps } from "./use-spade-conversation.ts";
import { groupsKey } from "./use-spade-groups.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/**
 * One group's conversation, live (ADR 0132): read like a bot's, from its `conversation`; the
 * person posts to the group itself, which starts a run, and Stop ends the run.
 */
export function useGroupConversation(group: { id: string; conversation: string }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const ready = useSpadeStatus()?.state === "ready";
  const [follow] = useState(
    () => new GroupFollow(spadeTransport(client), group.conversation, followDeps),
  );
  useEffect(() => {
    follow.start();
    return () => follow.stop();
  }, [follow]);
  useEffect(() => follow.setReady(ready), [follow, ready]);
  const snapshot = useSyncExternalStore(follow.subscribe, follow.get, follow.get);
  const listChanged = () => void cache.invalidateQueries({ queryKey: groupsKey });

  return {
    ...snapshot,
    ready,
    retry: () => follow.retry(),
    async send(message: SpadeMessage): Promise<void> {
      const refused = groupRefusal(message);
      if (refused) throw new Error(refused);
      const key = `local-${crypto.randomUUID()}`;
      follow.apply({ kind: "sent", key, text: message.text });
      try {
        await postGroupMessage(client, group.id, message.text);
        listChanged();
      } catch (error) {
        // No answer came back: Spade may have it. Only a message it never stored comes back.
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
        await stopGroup(client, group.id);
      } catch (error) {
        // 404: nothing was running by the time Stop arrived, which is what Stop wanted.
        if (!(error instanceof SpadeRequestError && error.status === 404)) throw error;
      }
    },
  };
}

/** Why a group can't take `message` as it is, or `undefined` when it can: groups take words. */
export function groupRefusal(message: SpadeMessage): string | undefined {
  if (message.images.length || message.documents?.length || message.voice)
    return "A group takes words only, not images, files or recordings.";
  return undefined;
}
