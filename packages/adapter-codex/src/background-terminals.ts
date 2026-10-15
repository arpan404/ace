import { z } from "zod";
const TerminalPage = z
  .object({
    data: z
      .array(
        z
          .object({ processId: z.string().min(1).max(1024), itemId: z.string().optional() })
          .passthrough(),
      )
      .max(256),
    nextCursor: z.string().min(1).max(4096).nullish(),
  })
  .passthrough();

/** Read Codex's live shells with bounded pages and checked continuation cursors. */
export async function readBackgroundTerminals(
  request: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
): Promise<z.infer<typeof TerminalPage>["data"]> {
  const terminals: z.infer<typeof TerminalPage>["data"] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 64; page++) {
    const result = TerminalPage.parse(
      await request("thread/backgroundTerminals/list", {
        threadId,
        ...(cursor ? { cursor } : {}),
      }),
    );
    terminals.push(...result.data);
    if (terminals.length > 4096) throw new Error("Codex terminal capacity reached");
    if (!result.nextCursor) return terminals;
    if (cursors.has(result.nextCursor)) throw new Error("Repeated Codex terminal cursor");
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error("Codex terminal pagination capacity reached");
}
