import type { Attachment, ContextOperation, ContextResult } from "@ace/protocol";

type ListOperation = Extract<ContextOperation, { op: "attachment.list" }>;
type Result = ContextResult["result"];

/**
 * Every file a thread stores, newest first, read page by page. A thread can hold any number of
 * files, so the daemon sends them in pages and this follows `nextCursor` to the end. A daemon
 * from before paging answers one page with no cursor, which ends the walk there.
 *
 * `ask` sends one `attachment.list` and returns the daemon's result. A result that isn't an
 * `attachments` page is handed to `refused`, which must throw.
 */
export async function listThreadAttachments(
  threadId: ListOperation["threadId"],
  ask: (operation: ListOperation) => Promise<Result>,
  refused: (result: Result) => never,
): Promise<Attachment[]> {
  const files: Attachment[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const result = await ask({
      op: "attachment.list",
      threadId,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.kind !== "attachments") refused(result);
    files.push(...result.attachments);
    // A cursor seen before would loop forever; stop rather than trust it.
    if (result.nextCursor === undefined || seen.has(result.nextCursor)) return files;
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}
