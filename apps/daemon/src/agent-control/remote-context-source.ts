import { freezeRemoteAttachments } from "./remote-attachments.ts";
import { summarizeThreadReference, type ContextService } from "@ace/context";
import type { RemoteTask, RemoteContextManifest } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { FilesWorkspaces } from "../files-workspaces.ts";
/** Freeze selected workspace files into the source thread's immutable attachment store. */
export async function prepareRemoteContext(
  options: {
    store: Store;
    context?: ContextService | undefined;
    files?: FilesWorkspaces | undefined;
  },
  task: RemoteTask,
  signal: AbortSignal,
): Promise<RemoteContextManifest> {
  const thread = options.store.getThread(task.parentThreadId);
  if (!thread || thread.deletedAt !== undefined) throw new Error("Source thread unavailable");
  const reference = summarizeThreadReference(
    {
      type: "thread_ref",
      threadId: thread.id,
      budgetBytes: task.request.context?.threadBudgetBytes ?? 4096,
    },
    thread,
    options.store.readItemPage(thread.id, options.store.headSeq() + 1, 20, 32768),
  );
  const attachments = await freezeRemoteAttachments(
    options,
    thread.id,
    task.request.context,
    signal,
  );
  return {
    sourceHostId: task.sourceHostId,
    sourceThreadId: thread.id,
    summary: reference.summary,
    before: reference.pointer.before,
    attachments,
  };
}
