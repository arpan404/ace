import { ClientError } from "@ace/client";
import {
  ThreadId,
  type SourceControlContext,
  type SourceControlSelection,
  type WorkspaceActionRequest,
} from "@ace/protocol";
import { actionErrorText, checkoutOf } from "@ace/ui-core/mobile";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { WorkspaceRefusal, type ChangesOwner, type ChangesSession } from "./changes.ts";

/*
 * AI-drafted commit messages and PR titles for the Changes sheet, through the daemon's own
 * writer (`git.draft.context`, then `git.draft.generate`), as the web's Draft button asks. The
 * draft's fingerprint stays with the session: publishing it later names the same changes, and
 * the daemon refuses once they moved. One draft at a time; Cancel or closing the sheet stops it.
 */

export const DraftFor = z.enum(["commit", "create-pr"]);
export type DraftFor = z.infer<typeof DraftFor>;

/** How long the daemon's writer may take, as the web allows. */
const generateTimeoutMs = 150_000;

/** The changes a draft is written about: every file the sheet read, or the branch against its base. */
export function draftSelection(session: ChangesSession, kind: DraftFor): SourceControlSelection {
  const reads = session.reads;
  if (kind === "commit") {
    // A commit with a draft names its files; a list cut at the read cap can't be named whole.
    if (!reads || reads.truncated) throw new WorkspaceRefusal("draft_changes_moved");
    const paths = [
      ...new Set(reads.files.flatMap((file) => (file.from ? [file.path, file.from] : [file.path]))),
    ];
    if (paths.length === 0 || paths.length > 1000)
      throw new WorkspaceRefusal("draft_changes_moved");
    return { kind: "commit", paths };
  }
  const checkout = checkoutOf(session.details, reads?.pr);
  if (!checkout?.branch) throw new WorkspaceRefusal("pr_unavailable");
  // A draft is written against a known base; without one the daemon picks it, so no draft.
  if (!checkout.baseBranch) throw new WorkspaceRefusal("draft_changes_moved");
  return {
    kind: "pr",
    branch: checkout.branch,
    base: checkout.baseBranch,
    ...(checkout.baseRef ? { baseRef: checkout.baseRef } : {}),
  };
}

async function workspace(
  owner: ChangesOwner,
  operation: WorkspaceActionRequest["operation"],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const reply = await owner.request({ type: "workspace.request", operation }, options);
  if (reply.result.kind === "error") throw new WorkspaceRefusal(reply.result.code);
  return reply.result;
}

/** The daemon's fingerprint of the changes now, for checking a draft before it is published. */
export async function draftContext(
  owner: ChangesOwner,
  threadId: string,
  selection: SourceControlSelection,
): Promise<SourceControlContext> {
  const result = await workspace(owner, {
    op: "git.draft.context",
    threadId: ThreadId.parse(threadId),
    selection,
  });
  if (result.kind !== "draftContext") throw new WorkspaceRefusal("unexpected");
  return result.context;
}

function failureText(error: unknown): string {
  if (error instanceof WorkspaceRefusal || error instanceof ClientError)
    return actionErrorText(error.code);
  return actionErrorText(undefined);
}

/**
 * Write a draft. Its state arrives as one `git.draft` patch: drafting, then ready (subject and
 * body to fill the fields), failed (the shared wording) or cancelled.
 */
export async function writeDraft(
  owner: ChangesOwner,
  session: ChangesSession,
  kind: DraftFor,
  requestId: string,
  sink: PatchSink,
  preview: Preview,
): Promise<void> {
  const put = (state: "drafting" | "ready" | "failed" | "cancelled", extra = {}) =>
    sink.put("git:draft", () => ({ type: "git.draft", id: requestId, for: kind, state, ...extra }));
  if (session.drafting) return put("failed", { message: actionErrorText("draft_busy") });
  const controller = new AbortController();
  const generation = { id: requestId, controller };
  session.drafting = generation;
  const threadId = ThreadId.parse(session.threadId);
  // Cancel and closing abort the read and tell the daemon's writer to stop.
  controller.signal.addEventListener(
    "abort",
    () => {
      void workspace(owner, { op: "git.draft.cancel", threadId, generationId: requestId }).catch(
        () => {},
      );
    },
    { once: true },
  );
  put("drafting");
  try {
    const selection = draftSelection(session, kind);
    const context = await draftContext(owner, session.threadId, selection);
    if (controller.signal.aborted) return put("cancelled");
    const result = await workspace(
      owner,
      {
        op: "git.draft.generate",
        threadId,
        input: {
          generationId: requestId,
          selection,
          fingerprint: context.fingerprint,
          preference: "",
        },
      },
      { signal: controller.signal, timeoutMs: generateTimeoutMs },
    );
    if (controller.signal.aborted) return put("cancelled");
    if (result.kind !== "draft") throw new WorkspaceRefusal("unexpected");
    session.draft = { for: kind, fingerprint: result.context.fingerprint, selection };
    put("ready", {
      subject: preview(result.draft.subject, 256),
      body: preview(result.draft.body, 8192),
    });
  } catch (error) {
    if (controller.signal.aborted) put("cancelled");
    else put("failed", { message: preview(failureText(error), 2048) });
  } finally {
    if (session.drafting === generation) session.drafting = undefined;
  }
}

/** Stop the draft being written, if `requestId` is still the one running. */
export function cancelDraft(session: ChangesSession, requestId: string): void {
  const generation = session.drafting;
  if (!generation || generation.id !== requestId) return;
  session.drafting = undefined;
  generation.controller.abort();
}
