import { z } from "zod";
import type { ClientCore } from "@ace/client";
import { WorkspaceId } from "@ace/protocol";
import { pastSessionProblems } from "@ace/ui-core";

/*
 * Opening a past CLI session from the phone, as the web's Past sessions list does: Import reads
 * the saved conversation into a thread; Continue imports it, then resumes it in its provider with
 * nothing sent yet, so the person's next message goes to the provider's own session. The words
 * are shared with the web (`@ace/ui-core`).
 */

export const PastSessionOpenRequest = z.object({
  type: z.literal("pastSessions.open"),
  sourceId: z.string().min(1).max(4096),
  workspaceId: WorkspaceId,
  action: z.enum(["import", "continue"]),
});
export type PastSessionOpenRequest = z.infer<typeof PastSessionOpenRequest>;

/** The thread to open, or why there is none. */
export interface PastSessionOpened {
  threadId: string | null;
  problem: string | null;
}

const failed = (problem: string): PastSessionOpened => ({ threadId: null, problem });

export async function openPastSession(
  owner: ClientCore,
  request: PastSessionOpenRequest,
  signal: AbortSignal,
): Promise<PastSessionOpened> {
  try {
    const imported = await owner.request(
      { type: "history.import", sourceId: request.sourceId, workspaceId: request.workspaceId },
      { signal },
    );
    if (imported.status !== "imported") return failed(pastSessionProblems.notImported);
    if (request.action === "continue") {
      const continued = await owner.request(
        {
          type: "history.continue",
          threadId: imported.threadId,
          mode: "resume",
          input: [],
          delivery: "queue",
        },
        { signal },
      );
      // As on the web: imported, but not opened, so Import stays the way to read it.
      if (continued.status !== "continued") return failed(pastSessionProblems.notContinued);
    }
    return { threadId: imported.threadId, problem: null };
  } catch {
    return failed(pastSessionProblems.notOpened);
  }
}
