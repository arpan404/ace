import type { ThreadId, WorkspaceId } from "@ace/protocol";

/*
 * Opening a past CLI session, shared by the web's Past sessions list and the phone's: Import
 * reads the saved conversation into a thread; Continue imports it, then resumes it in its
 * provider with nothing sent yet, so the person's next message goes to the provider's own
 * session. The machine is reached through the caller's ports; the steps, the resume options and
 * which failures stop it live here.
 */

/** Import reads a saved conversation into a thread; Continue also resumes it in its provider. */
export type PastSessionAction = "import" | "continue";

export const pastSessionProblems = {
  notImported:
    "This saved conversation couldn't be imported. Open it in its original app, then try again.",
  notContinued:
    "The conversation was imported, but couldn't continue. Use Import to read it, or check the provider in Settings.",
  notOpened: "The saved conversation couldn't be opened. Find past sessions again and retry.",
} as const;

export interface PastSessionSource {
  sourceId: string;
  workspaceId: WorkspaceId;
}

/** The two machine requests opening takes, as `history.import` and `history.continue`. */
export interface PastSessionPorts {
  importSession(request: {
    type: "history.import";
    sourceId: string;
    workspaceId: WorkspaceId;
  }): Promise<{ status: "imported"; threadId: ThreadId } | { status: "unsupported" }>;
  continueSession(request: {
    type: "history.continue";
    threadId: ThreadId;
    mode: "resume";
    input: [];
    delivery: "queue";
  }): Promise<{ status: "continued" } | { status: "unsupported" }>;
}

/** The thread to open, or why there is none. */
export type PastSessionOpened =
  | { threadId: ThreadId; problem: null }
  | { threadId: null; problem: string };

const failed = (problem: string): PastSessionOpened => ({ threadId: null, problem });

export async function openPastSession(
  ports: PastSessionPorts,
  source: PastSessionSource,
  action: PastSessionAction,
): Promise<PastSessionOpened> {
  try {
    const imported = await ports.importSession({ type: "history.import", ...source });
    if (imported.status !== "imported") return failed(pastSessionProblems.notImported);
    if (action === "continue") {
      const continued = await ports.continueSession({
        type: "history.continue",
        threadId: imported.threadId,
        mode: "resume",
        input: [],
        delivery: "queue",
      });
      // Imported, but not opened, so Import stays the way to read it.
      if (continued.status !== "continued") return failed(pastSessionProblems.notContinued);
    }
    return { threadId: imported.threadId, problem: null };
  } catch {
    return failed(pastSessionProblems.notOpened);
  }
}
