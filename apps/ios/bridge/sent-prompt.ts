import type { ClientCore } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { sentText } from "@ace/ui-core";
import { z } from "zod";

/*
 * A message the person sent in a thread, for the composer's Previous message: `older` 0 is the
 * latest, 1 the one before it. The shared rule (`sentText`) skips what ace sent on their behalf.
 * Read from the thread's loaded window, which the open thread always has.
 */

export const SentPromptRequest = z.object({
  type: z.literal("thread.sentText"),
  threadId: ThreadId,
  older: z.number().int().nonnegative().max(10_000),
});

export function readSentPrompt(
  owner: Pick<ClientCore, "cachedThread">,
  request: z.infer<typeof SentPromptRequest>,
): { type: "thread.sentText"; older: number; text: string | null } {
  const thread = owner.cachedThread(request.threadId);
  const text = thread ? sentText(thread, request.older) : undefined;
  return { type: "thread.sentText", older: request.older, text: text ?? null };
}
