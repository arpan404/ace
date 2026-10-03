import { z } from "zod";
import { PiHistoryError } from "./history-errors.ts";
const Id = z.string().min(1).max(128);
const Entry = z.object({
  id: Id,
  parentId: Id.nullable(),
  type: z.string(),
  message: z.object({ role: z.string() }).optional(),
});
const Entries = z.object({ entries: z.array(Entry).max(4096), leafId: Id.nullable() });
/** Cold control preflight. Inspect native ancestry, never copy or rewrite its transcript. */
export function requireDurableFork(value: unknown, target?: string): void {
  const parsed = Entries.safeParse(value);
  if (!parsed.success) throw new PiHistoryError("forkState");
  const { entries, leafId } = parsed.data;
  const index = new Map(entries.map((entry) => [entry.id, entry]));
  if (index.size !== entries.length) throw new PiHistoryError("forkState");
  let cursor = leafId;
  if (target !== undefined) {
    const entry = index.get(target);
    // Pi RPC fork selects the position before a user entry; clone selects the leaf.
    if (entry?.type !== "message" || entry.message?.role !== "user")
      throw new PiHistoryError("entry");
    cursor = entry.parentId;
  }
  let visited = 0;
  let assistant = false;
  while (cursor !== null) {
    const entry = index.get(cursor);
    if (!entry || ++visited > entries.length) throw new PiHistoryError("forkState");
    if (entry.type === "message" && entry.message?.role === "assistant") assistant = true;
    cursor = entry.parentId;
  }
  if (!assistant) throw new PiHistoryError("unflushedFork");
}
