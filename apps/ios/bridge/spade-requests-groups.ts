import { SpadeRequestError } from "@ace/ui-core/spade-chat";
import { z } from "zod";
import type { NativeSpade } from "./spade.ts";
import { segment } from "./spade-text.ts";
import { spadeRefused, spadeRequestArea, type SpadeOutcome } from "./spade-requests-area.ts";

/* A group (ADR 0132): post to it, and stop its run. */

const groupId = z.string().min(1).max(256);

/** A message the person posts to a group: it starts a run its lead answers. */
const SpadeGroupSendRequest = z.object({
  type: z.literal("spade.group.send"),
  groupId,
  conversationId: z.string().min(1).max(256),
  text: z.string().trim().min(1).max(200_000),
});

export const spadeGroupRequests = spadeRequestArea(
  [
    SpadeGroupSendRequest,
    /** Stop ends the group's run: every ask still open, on every machine. */
    z.object({ type: z.literal("spade.group.stop"), groupId }),
    /** Pin the group to the strip above the list, or unpin it, on every device. */
    z.object({ type: z.literal("spade.group.pin"), groupId, pinned: z.boolean() }),
  ],
  async ({ spade, deps, ask }, request): Promise<SpadeOutcome> => {
    switch (request.type) {
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
            return spadeRefused("Couldn't stop", error);
        }
        spade.refresh();
        return { ok: true };
      case "spade.group.pin":
        try {
          await ask("PUT", `/v1/groups/${segment(request.groupId)}/pin`, {
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
 * A post to a group shows at once, as a bot's message does; one Spade never stored is refused,
 * so its words go back to the composer.
 */
async function sendToGroup(
  spade: NativeSpade,
  request: z.infer<typeof SpadeGroupSendRequest>,
  deps: { id(): string },
  post: () => Promise<string>,
): Promise<SpadeOutcome> {
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
    return spadeRefused(name ? `Couldn't send to ${name}` : "Couldn't send", error);
  }
}
