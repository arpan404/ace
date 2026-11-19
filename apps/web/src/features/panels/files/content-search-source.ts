import type { ClientApi } from "@ace/client";
import {
  FileSearchSummary,
  ThreadId,
  type FileSearchFile,
  type FileOperation,
} from "@ace/protocol";
import { CheckoutError, checkoutError, fromCode } from "./checkout-source.ts";

/** What the person asked for in the Search view. */
export interface ContentQuery {
  pattern: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Globs, as typed: comma separated. */
  include: string;
  exclude: string;
}

/** The most matches one search shows; past it, the view says the list was cut. */
export const searchMatchLimit = 2000;
/** A search the daemon is still walking after this long is given up on. */
const searchTimeoutMs = 5 * 60_000;

const sentences: Record<string, string> = {
  INVALID_ARGUMENT: "That pattern or file filter isn't valid.",
  FILES_RESTARTING: "File search is starting up on this machine. Try again in a moment.",
};

/** The globs of a comma-separated field, trimmed, without empty entries. */
export function globs(field: string): string[] {
  return field
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
    .slice(0, 64);
}

function searchFailure(code: string): CheckoutError {
  const sentence = sentences[code];
  return sentence ? new CheckoutError(code, sentence) : fromCode(code);
}

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
  const operation: Extract<FileOperation, { op: "search" }> = {
    op: "search",
    pattern: query.pattern,
    regex: query.regex,
    case: query.matchCase ? "sensitive" : "insensitive",
    wholeWord: query.wholeWord,
    include: globs(query.include),
    exclude: globs(query.exclude),
    includeIgnored: false,
    maxMatches: searchMatchLimit,
    maxFileBytes: 4 * 1024 * 1024,
  };
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
