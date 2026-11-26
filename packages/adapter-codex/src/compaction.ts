/**
 * Codex's own compaction, `thread/compact/start` on the app-server (its documented way to
 * summarise a thread's history in place). The response is `{}`: the compaction runs as its own
 * turn, which reports `contextCompaction` items and ends normally.
 */
export function codexCompactCommand(
  request: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
  assertOpen: () => void,
) {
  return {
    async compact(): Promise<void> {
      assertOpen();
      await request("thread/compact/start", { threadId });
    },
  };
}
