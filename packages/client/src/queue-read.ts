import type { QueueGet, QueuePage, ThreadId } from "@ace/protocol";

type ReadQueue = (
  request: Pick<QueueGet, "threadId" | "limit" | "after" | "expectedRevision">,
) => Promise<QueuePage>;

/**
 * A thread's whole daemon queue at one revision, following the daemon's byte-bounded cursors.
 * Every later page is fenced to the first page's revision; a moved queue or a cursor that loops
 * rejects, so callers read again at the new revision.
 */
export async function readServerQueue(threadId: ThreadId, read: ReadQueue): Promise<QueuePage> {
  const first = await read({ threadId, limit: 32 });
  const messages = [...first.messages];
  let next = first.next;
  const cursors = new Set<string>();
  while (next !== null) {
    if (cursors.has(next) || messages.length >= first.total)
      throw new Error("invalid_queue_cursor");
    cursors.add(next);
    const page = await read({ threadId, limit: 32, after: next, expectedRevision: first.revision });
    if (page.revision !== first.revision) throw new Error("queue_conflict");
    messages.push(...page.messages);
    next = page.next;
  }
  return { ...first, messages, next: null };
}
