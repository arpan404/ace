import { z } from "zod";
import { Interaction, InteractionId, ThreadId } from "@ace/protocol";
import type { ServiceContext } from "./services/types.ts";

/** Durable ownership is written before a private lease, including connected takeovers. */
export function privateBrowserOwnership(context: ServiceContext) {
  const { store, services, now, id } = context;
  const gate = (threadId: string) => {
    const row = store
      .statement(`SELECT entity.id AS interactionId, json_extract(raw.value, '$.data.key') AS key
      FROM view_entities AS entity, json_each(entity.value, '$.raw') AS raw
      WHERE entity.thread_id=? AND entity.collection='interactions'
      AND json_extract(entity.value, '$.state')='pending'
      AND json_extract(raw.value, '$.type')='ace.browser.private' LIMIT 1`)
      .get(ThreadId.parse(threadId));
    const parsed = z.object({ interactionId: InteractionId, key: z.string() }).safeParse(row);
    return parsed.success ? parsed.data : undefined;
  };
  return {
    isPrivatePaused: (threadId: string) => gate(threadId) !== undefined,
    onPrivatePaused: (rawThreadId: string) => {
      const threadId = ThreadId.parse(rawThreadId);
      if (gate(threadId)) return;
      const key = `browser-private:${id()}`;
      const request = {
        kind: "plan_review" as const,
        title: "Private browser ownership",
        markdown:
          "Private browser control is held by a human. Take over in private mode and explicitly hand back control to resume the agent.",
      };
      const raw = [{ type: "ace.browser.private", data: { key } }];
      if (services.engine) services.engine.openHostApproval(threadId, key, request, raw);
      else {
        const agentId = store.getThread(threadId)?.rootAgentId;
        if (!agentId) throw new Error("Private browser owner unavailable");
        const interaction = Interaction.parse({
          id: id(),
          threadId,
          agentId,
          blocking: true,
          state: "pending",
          createdAt: now(),
          request,
          raw,
        });
        store.appendEvents(threadId, [{ type: "interaction.opened", interaction }], now());
      }
    },
    onPrivateResumed: (rawThreadId: string) => {
      const threadId = ThreadId.parse(rawThreadId),
        pending = gate(threadId);
      if (!pending) return;
      if (services.engine) services.engine.closeHostGate(threadId, pending.key, "resolved");
      else
        store.appendEvents(
          threadId,
          [
            {
              type: "interaction.closed",
              interactionId: pending.interactionId,
              closedAt: now(),
              state: "resolved",
            },
          ],
          now(),
        );
    },
  };
}
