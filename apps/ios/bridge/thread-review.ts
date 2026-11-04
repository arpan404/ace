import type { ThreadSource } from "@ace/client";
import type { ThreadDetails, ThreadStatus } from "@ace/protocol";
import { isPending, sendDrafts, type ReviewDraft } from "@ace/ui-core/review";
import type { PatchSink, Preview } from "./agents.ts";
import type { ChangesKept } from "./changes-kept.ts";
import type { ChangesOwner } from "./changes.ts";

/*
 * The thread's review outside the Changes page, for as long as the thread is open: whether a
 * finished turn is ready to review (the quiet line under the agent's last message and its
 * sheet), and the unsent line comments the composer carries as one chip. Comments live in the
 * phone's kept review, the same drafts the Changes page writes and the web's review reads once
 * they're sent, and go to the agent through the daemon's review turn, as the web's
 * Request changes sends them.
 */

/** What the review line says and the sheet starts from; undefined while there's nothing to review. */
export interface ReviewReady {
  files: number;
  additions: number;
  deletions: number;
  /** "9 files · +214 −61 · checks passed": the line as one string, for VoiceOver too. */
  line: string;
  branch: string;
  /** The thread's pull request, when one is linked. */
  pr: { number: number; state: string; url: string } | null;
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const checksWord = { passed: "checks passed", failed: "checks failed", pending: "checks running" };

/**
 * A turn is ready to review once the daemon says the whole tree is done (every agent idle,
 * nothing pending, nothing running in the background) and the checkout holds changes. Any other
 * state, a working subagent or a question waiting on the person included, shows nothing.
 * Chats have no checkout to review.
 */
export function reviewReady(
  status: ThreadStatus | undefined,
  details: ThreadDetails | undefined,
): ReviewReady | undefined {
  if (status?.state !== "done") return undefined;
  if (details?.workspace?.kind === "chat") return undefined;
  const diff = details?.diff;
  if (!diff || diff.files === 0) return undefined;
  const linked = details.linkedPrs?.[0];
  const checks = linked?.checks ? checksWord[linked.checks] : undefined;
  const parts = [plural(diff.files, "file", "files"), `+${diff.additions} −${diff.deletions}`];
  if (checks) parts.push(checks);
  return {
    files: diff.files,
    additions: diff.additions,
    deletions: diff.deletions,
    line: parts.join(" · "),
    branch: details.branch ?? "",
    pr: linked ? { number: linked.number, state: linked.state, url: linked.url } : null,
  };
}

/** The composer's comment chip: "2 comments on wires.ts", "3 comments on 2 files". */
export interface CommentChip {
  count: number;
  label: string;
  /** Where the newest comment is, so the chip can open it. */
  path: string;
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/** The thread's unsent comments (drafts and failed sends) as one chip; undefined with none. */
export function commentChip(
  drafts: readonly ReviewDraft[],
  threadId: string,
): CommentChip | undefined {
  const unsent = drafts
    .filter((draft) => draft.threadId === threadId && isPending(draft))
    .toSorted((a, b) => b.createdAt - a.createdAt);
  const newest = unsent[0];
  if (!newest) return undefined;
  const files = new Set(unsent.map((draft) => draft.file));
  const where = files.size === 1 ? base(newest.file) : plural(files.size, "file", "files");
  return {
    count: unsent.length,
    label: `${plural(unsent.length, "comment", "comments")} on ${where}`,
    path: newest.file,
  };
}

export interface ThreadReviewDeps {
  owner: ChangesOwner;
  store: Pick<ThreadSource, "thread" | "observe">;
  threadId: string;
  epoch: number;
  kept: ChangesKept;
  sink: PatchSink;
  preview: Preview;
  id: () => string;
}

/** Follows the open thread's ready state and comment chip; `stop` when the thread is left. */
export class ThreadReview {
  #deps: ThreadReviewDeps;
  #stops: (() => void)[] = [];
  #ready = "";
  #closed = false;

  constructor(deps: ThreadReviewDeps) {
    this.#deps = deps;
    this.#stops.push(deps.kept.subscribe(() => this.#chip()));
    this.#stops.push(
      deps.store.observe((keys) => {
        if (keys === "all" || keys.has("thread")) this.#readyPatch();
      }),
    );
    void deps.kept.load();
    this.#readyPatch();
    this.#chip();
  }

  /** Send every unsent comment of the thread to the agent; answers on `changes:notice`. */
  send(requestId: string): void {
    const { owner, kept, store, threadId, id } = this.#deps;
    const thread = store.thread;
    const keys = kept
      .get()
      .filter((draft) => draft.threadId === threadId && isPending(draft))
      .map((draft) => draft.key);
    const done = (refusal: string | undefined) => this.#notice(requestId, refusal);
    if (!thread) return done("The thread isn't loaded yet.");
    if (!keys.length) return done(undefined);
    void sendDrafts(owner, kept, { id: thread.id, workspaceId: thread.workspaceId }, keys, id).then(
      () => {
        // A send that failed leaves its drafts `failed`, with the daemon's reason on each.
        const failed = kept.get().find((draft) => keys.includes(draft.key) && draft.error);
        done(failed?.error);
      },
      () => done("Couldn't send the comments. Try again."),
    );
  }

  /** Take every unsent comment off the thread. */
  clear(): void {
    const { kept, threadId } = this.#deps;
    kept.set((drafts) =>
      drafts.filter((draft) => draft.threadId !== threadId || !isPending(draft)),
    );
  }

  stop(): void {
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    this.#deps.sink.clear("changes:ready");
    this.#deps.sink.clear("changes:chip");
  }

  #readyPatch(): void {
    const { store, sink, threadId, epoch } = this.#deps;
    const ready = reviewReady(store.thread?.status, store.thread?.details);
    const key = JSON.stringify(ready ?? null);
    if (key === this.#ready) return;
    this.#ready = key;
    sink.put("changes:ready", () =>
      this.#closed ? undefined : { type: "changes.ready", threadId, epoch, ready: ready ?? null },
    );
  }

  #chip(): void {
    const { kept, sink, preview, threadId, epoch } = this.#deps;
    sink.put("changes:chip", () => {
      if (this.#closed) return undefined;
      const chip = commentChip(kept.get(), threadId);
      return {
        type: "changes.chip",
        threadId,
        epoch,
        chip: chip
          ? { ...chip, label: preview(chip.label, 256), path: preview(chip.path, 1024) }
          : null,
      };
    });
  }

  #notice(requestId: string, refusal: string | undefined): void {
    const { sink, preview, threadId, epoch } = this.#deps;
    sink.put("changes:notice", () => ({
      type: "changes.notice",
      threadId,
      epoch,
      requestId,
      action: "review.comments.send",
      ok: refusal === undefined,
      message: refusal === undefined ? "" : preview(refusal, 512),
    }));
  }
}
