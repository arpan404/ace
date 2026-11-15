import { z } from "zod";
import type { ClientCore } from "@ace/client";
import { WorkspaceId } from "@ace/protocol";
import { openPastSession as open, type PastSessionOpened } from "@ace/ui-core";

/*
 * Opening a past CLI session from the phone (`pastSessions.open`), as the web's Past sessions
 * list does: the steps and words are shared (`@ace/ui-core`); this sends them to the machine.
 */

export const PastSessionOpenRequest = z.object({
  type: z.literal("pastSessions.open"),
  sourceId: z.string().min(1).max(4096),
  workspaceId: WorkspaceId,
  action: z.enum(["import", "continue"]),
});
export type PastSessionOpenRequest = z.infer<typeof PastSessionOpenRequest>;

export function openPastSession(
  owner: ClientCore,
  request: PastSessionOpenRequest,
  signal: AbortSignal,
): Promise<PastSessionOpened> {
  return open(
    {
      importSession: (message) => owner.request(message, { signal }),
      continueSession: (message) => owner.request(message, { signal }),
    },
    { sourceId: request.sourceId, workspaceId: request.workspaceId },
    request.action,
  );
}
