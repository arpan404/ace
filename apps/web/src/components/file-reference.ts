import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { isCheckoutPath } from "@ace/ui-core";
import {
  resolveFileReference,
  workspaceRelative,
  type FileReference,
  type FileResolution,
} from "@ace/ui-core/file-references";
import {
  filePreviewTab,
  fileTabId,
  findTab,
  tabKey,
  type OpenTab,
  type ScopeWorkspace,
} from "@/lib/workspace/index.ts";

/*
 * A file an answer mentions (`loader.ts`, `src/app/x.tsx:42`), linked once the thread's checkout
 * confirms it. Resolution asks the daemon's path index once per path per thread, and only for
 * settled text. A unique match opens in the side panel's Files view at its line; several matches
 * open the Files tree filtered to the name. An absolute path the checkout doesn't hold (outside
 * the project, or ignored inside it) opens beside the thread as a file the answer names, which
 * the daemon serves because the answer names it. Anything else stays plain text or code.
 */

/** Where a mention leads: checkout files, or a file the answer `itemId` names by absolute path. */
export type MentionResolution =
  | FileResolution
  | { kind: "outside"; path: string; threadId: string; itemId: string };

const searchLimit = 50;
/** Answers remembered per connection; the oldest go first past this. */
const cacheLimit = 2000;

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
): Promise<FileResolution> {
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
  return resolveFileReference(path, result.paths.filter(isCheckoutPath));
}

// Settled answers only: the same mention in a thread never asks twice.
const answers = new WeakMap<ClientApi, Map<string, FileResolution>>();

/**
 * Which file `reference` names in the thread whose checkout is at `root`: a checkout file, else
 * (for an absolute path in answer `itemId`) the file at that path, wherever it is.
 */
export async function resolveFileMention(
  client: ClientApi,
  thread: { threadId: string; root: string | undefined; itemId?: string | undefined },
  reference: FileReference,
  signal: AbortSignal,
): Promise<MentionResolution> {
  const { itemId } = thread;
  const outside: MentionResolution =
    itemId && reference.path.startsWith("/")
      ? { kind: "outside", path: reference.path, threadId: thread.threadId, itemId }
      : { kind: "none" };
  const found = await checkoutFile(client, thread, reference, signal);
  return found.kind === "none" ? outside : found;
}

async function checkoutFile(
  client: ClientApi,
  thread: { threadId: string; root: string | undefined },
  reference: FileReference,
  signal: AbortSignal,
): Promise<FileResolution> {
  const relative = workspaceRelative(reference.path, thread.root);
  if (!relative) return { kind: "none" };
  const cache = answers.get(client) ?? new Map<string, FileResolution>();
  answers.set(client, cache);
  const key = `${thread.threadId}\u0000${relative}`;
  const known = cache.get(key);
  if (known) return known;
  const resolution = await lookup(client, thread.threadId, relative, signal);
  if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, resolution);
  return resolution;
}

function objectData(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? { ...data } : {};
}

/**
 * The Files tab a resolved mention opens: the file at its line, or, for a name several files
 * share, the tree filtered to it. The tab's other state (`workspace`'s copy) is kept.
 */
export function fileMentionTab(
  workspace: ScopeWorkspace,
  reference: FileReference,
  resolution: Exclude<MentionResolution, { kind: "none" }>,
): OpenTab {
  if (resolution.kind === "outside")
    return filePreviewTab({
      name: resolution.path.split("/").at(-1) || resolution.path,
      source: {
        kind: "link",
        threadId: resolution.threadId,
        itemId: resolution.itemId,
        reference: resolution.path,
      },
    });
  if (resolution.kind === "file") {
    const id = fileTabId(resolution.path);
    const existing = findTab(workspace, tabKey("files", id));
    return {
      kind: "files",
      id,
      data: {
        ...objectData(existing?.tab.data),
        path: resolution.path,
        preview: false,
        ...(reference.line === undefined ? {} : { line: reference.line }),
      },
    };
  }
  const tree = findTab(workspace, tabKey("files"));
  const name = reference.path.split("/").at(-1) ?? reference.path;
  return { kind: "files", data: { ...objectData(tree?.tab.data), query: name } };
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
