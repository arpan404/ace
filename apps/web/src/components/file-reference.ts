import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { isCheckoutPath } from "@ace/ui-core";
import {
  isMachinePath,
  resolveFileReference,
  workspaceRelative,
  type FileReference,
  type FileResolution,
} from "@ace/ui-core/file-references";
import { filePreviewTab, findInDeck, openInDeck, type DeckTarget } from "@/lib/workspace/index.ts";

/*
 * A file an answer mentions (`loader.ts`, `src/app/x.tsx:42`), linked once the thread's checkout
 * confirms it. Resolution asks ace-files' path index once per path per thread, and only for
 * settled text. A unique match opens in the thread's Deck at its line, as a glance; several
 * matches open the Deck's explorer filtered to the name. An absolute or home path (`~/Downloads/a.pdf`) the
 * checkout doesn't hold (outside the project, or ignored inside it) opens beside the thread as a file the answer names, which
 * the daemon serves because the answer names it. Anything else stays plain text or code.
 */

/** Where a mention leads: checkout files, or a file the answer `itemId` names by absolute path. */
export type MentionResolution =
  | FileResolution
  | { kind: "outside"; path: string; threadId: string; itemId: string };

const searchLimit = 50;
/** Answers remembered per connection; the oldest go first past this. */
const cacheLimit = 2000;
/** How long one mention waits on a building index, and how often it asks again. */
const building = { deadlineMs: 10_000, retryMs: 250 };
type BuildingWait = typeof building;

/** Wait `ms`, or fail with the signal's reason the moment it aborts. */
async function pause(signal: AbortSignal, ms: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

// One path lookup at a time per connection, so a long answer doesn't flood the daemon.
const tails = new WeakMap<ClientApi, Promise<unknown>>();
async function queued<T>(client: ClientApi, signal: AbortSignal, run: () => Promise<T>) {
  const current = (tails.get(client) ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      signal.throwIfAborted();
      return run();
    });
  tails.set(client, current);
  try {
    return await current;
  } finally {
    if (tails.get(client) === current) tails.delete(client);
  }
}

async function lookup(
  client: ClientApi,
  threadId: string,
  path: string,
  signal: AbortSignal,
  wait: BuildingWait = building,
): Promise<FileResolution | undefined> {
  const deadline = Date.now() + wait.deadlineMs;
  for (;;) {
    signal.throwIfAborted();
    const reply = await queued(client, signal, () =>
      client.request(
        {
          type: "context.request",
          operation: {
            op: "mention.complete",
            threadId: ThreadId.parse(threadId),
            query: path.slice(0, 128),
            limit: searchLimit,
          },
        },
        { signal },
      ),
    );
    const result = reply.result;
    if (result.kind !== "completion") return { kind: "none" };
    if (result.ready) return resolveFileReference(path, result.paths.filter(isCheckoutPath));
    // The index is still building: an empty answer here is not a miss, so ask again until the
    // deadline. Past it the mention stays plain text, and a later draw asks afresh.
    if (Date.now() + wait.retryMs > deadline) return undefined;
    await pause(signal, wait.retryMs);
  }
}

// Settled answers only: the same mention in a thread never asks twice.
const answers = new WeakMap<ClientApi, Map<string, FileResolution>>();

/**
 * Which file `reference` names in the thread whose checkout is at `root`: a checkout file, else
 * (for an absolute or home path in answer `itemId`) the file at that path, wherever it is.
 */
export async function resolveFileMention(
  client: ClientApi,
  thread: { threadId: string; root: string | undefined; itemId?: string | undefined },
  reference: FileReference,
  signal: AbortSignal,
  wait: BuildingWait = building,
): Promise<MentionResolution> {
  const { itemId } = thread;
  const outside: MentionResolution =
    itemId && isMachinePath(reference.path)
      ? { kind: "outside", path: reference.path, threadId: thread.threadId, itemId }
      : { kind: "none" };
  const found = await checkoutFile(client, thread, reference, signal, wait);
  return found.kind === "none" ? outside : found;
}

async function checkoutFile(
  client: ClientApi,
  thread: { threadId: string; root: string | undefined },
  reference: FileReference,
  signal: AbortSignal,
  wait: BuildingWait,
): Promise<FileResolution> {
  const relative = workspaceRelative(reference.path, thread.root);
  if (!relative) return { kind: "none" };
  const cache = answers.get(client) ?? new Map<string, FileResolution>();
  answers.set(client, cache);
  const key = `${thread.threadId}\u0000${relative}`;
  const known = cache.get(key);
  if (known) return known;
  const found = await lookup(client, thread.threadId, relative, signal, wait);
  if (found === undefined) return { kind: "none" };
  if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, found);
  return found;
}

/**
 * Follow a resolved mention: the file in the thread's Deck at its line, as a glance (the chat
 * keeps focus); for a name several files share, the Deck's explorer filtered to it; a file
 * outside the checkout beside the thread.
 */
export function openFileMention(
  deck: DeckTarget,
  reference: FileReference,
  resolution: Exclude<MentionResolution, { kind: "none" }>,
): void {
  if (resolution.kind === "outside")
    return deck.actions.open(
      filePreviewTab({
        name: resolution.path.split(/[\\/]/).at(-1) || resolution.path,
        source: {
          kind: "link",
          threadId: resolution.threadId,
          itemId: resolution.itemId,
          reference: resolution.path,
        },
      }),
    );
  if (resolution.kind === "file")
    return openInDeck(deck, resolution.path, { line: reference.line });
  findInDeck(deck, reference.path.split(/[\\/]/).at(-1) ?? reference.path);
}

/** What a resolved mention's link says it does. */
export function fileMentionLabel(
  text: string,
  reference: FileReference,
  resolution: Exclude<MentionResolution, { kind: "none" }>,
): string {
  if (resolution.kind === "outside") return `Open ${resolution.path}`;
  return resolution.kind === "file"
    ? `Open ${resolution.path}${reference.line ? ` at line ${reference.line}` : ""}`
    : `Find ${text} in Files (${resolution.paths.length} matches)`;
}
