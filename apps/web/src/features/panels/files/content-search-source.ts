import type { ClientApi } from "@ace/client";
import { FileSearchSummary, ThreadId, type FileSearchFile } from "@ace/protocol";
import { contentSearchOperation, searchFailure, type ContentQuery } from "@ace/ui-core";
import { checkoutError } from "./checkout-source.ts";

export type { ContentQuery };
export { searchGlobs as globs } from "@ace/ui-core";

/** A search the daemon is still walking after this long is given up on. */
const searchTimeoutMs = 5 * 60_000;

/**
 * Search a thread's checkout. Matches reach `onFiles` batch by batch as the daemon finds them;
 * the summary resolves once it is done. Aborting `signal` tells the daemon to stop.
 */
export async function searchContents(
  client: ClientApi,
  threadId: string,
  query: ContentQuery,
  options: { requestId: string; signal: AbortSignal; onFiles(files: FileSearchFile[]): void },
): Promise<FileSearchSummary> {
  const operation = contentSearchOperation(query);
  const stop = client.onMessage((message) => {
    if (message.type === "files.search.matches" && message.searchId === options.requestId)
      options.onFiles(message.files);
  });
  try {
    const reply = await client
      .request(
        { type: "files.request", threadId: ThreadId.parse(threadId), operation },
        { requestId: options.requestId, signal: options.signal, timeoutMs: searchTimeoutMs },
      )
      .catch((error: unknown) => {
        throw checkoutError(error);
      });
    if (reply.type === "files.error") throw searchFailure(reply.code);
    if (reply.type !== "files.result") throw new Error("Couldn't read the reply. Try again.");
    const summary = FileSearchSummary.safeParse(reply.value);
    if (!summary.success) throw new Error("Couldn't read the search results. Update ace.");
    return summary.data;
  } finally {
    stop();
  }
}
