import type { ChangeTap, ThreadSource } from "@ace/client";
import { ThreadId, WorkspaceId, type ThreadDetails } from "@ace/protocol";
import {
  actionErrorText,
  checkoutMoveReasons,
  checkoutNote,
  checkoutOf,
  checkoutProblem,
  defaultFirst,
  linkedPrProblem,
  prSummary,
  type CheckoutProblemAction,
  type CheckoutReadState,
} from "@ace/ui-core/mobile";
import type { PatchSink, Preview } from "./agents.ts";
import type { ChangesOwner, ChangesStore } from "./changes.ts";

/*
 * The thread's Work sheet while it is shown: where the checkout lives (machine, project, local
 * or worktree, branch), whether it may move now, its linked pull requests and what stops it.
 * Every decision is `@ace/ui-core`'s, the same the web's Work card makes. It reads the checkout
 * once when opened (as the web's card does) and then follows the thread's live details; the
 * branch list is read only when the person opens the branch picker. Closing releases it all.
 */

export type WorkStore = ChangesStore & Pick<ThreadSource, "queue">;

/** The words for one of a problem's ways out, and whether it asks before it runs. */
export function problemAction(action: CheckoutProblemAction): {
  id: string;
  label: string;
  destructive: boolean;
} {
  switch (action.kind) {
    case "retry-move":
      return { id: "retry-move", label: "Retry", destructive: false };
    case "clear-move":
      return { id: "clear-move", label: "Clear", destructive: true };
    case "move":
      return { id: `move-${action.move.mode}`, label: action.label, destructive: false };
    case "setup":
      return { id: `setup-${action.action}`, label: action.label, destructive: false };
  }
}

/** The problem action a phone named, if the checkout still has that problem. */
export function findProblemAction(
  details: ThreadDetails | undefined,
  id: string,
): CheckoutProblemAction | undefined {
  return checkoutProblem(details)?.actions.find((action) => problemAction(action).id === id);
}

/** The checkout is fenced by a lock an earlier daemon left (the queue's last failure says so). */
export const lockedOf = (store: Pick<WorkStore, "queue">) =>
  store.queue?.lastFailure?.code === "git_quarantined";

/** What a Work write needs: the thread, its live details and the move rules, and one-at-a-time. */
export interface WorkSubject {
  readonly owner: ChangesOwner;
  readonly threadId: string;
  readonly details: ThreadDetails | undefined;
  readonly reasons: ReturnType<typeof checkoutMoveReasons>;
  busy: boolean;
  summary(): void;
}

/**
 * The open thread as a Work write's subject when the Work sheet is closed: the transcript's
 * problem line acts on the live details as they stand.
 */
export function threadSubject(
  owner: ChangesOwner,
  store: WorkStore,
  threadId: string,
): WorkSubject {
  return {
    owner,
    threadId,
    busy: false,
    summary: () => {},
    get details() {
      return store.thread?.details;
    },
    get reasons() {
      const checkout = checkoutOf(store.thread?.details);
      return checkoutMoveReasons({
        status: store.thread?.status.state,
        checkout,
        state: checkout ? "ready" : "none",
      });
    },
  };
}

export class WorkSession implements WorkSubject {
  readonly threadId: string;
  readonly epoch: number;
  #owner: ChangesOwner;
  #store: WorkStore;
  #sink: PatchSink;
  #preview: Preview;
  #state: CheckoutReadState = "loading";
  #error = "";
  #closed = false;
  #branches:
    | { state: "loading" | "ready" | "error"; names: string[]; truncated: boolean }
    | undefined;
  #stop: () => void;
  /** A write is running; the sheet offers none twice. */
  busy = false;

  constructor(
    owner: ChangesOwner,
    store: WorkStore,
    threadId: string,
    epoch: number,
    sink: PatchSink,
    preview: Preview,
  ) {
    this.#owner = owner;
    this.#store = store;
    this.threadId = threadId;
    this.epoch = epoch;
    this.#sink = sink;
    this.#preview = preview;
    const change: ChangeTap = (keys) => {
      if (keys === "all" || keys.has("thread") || keys.has("queue")) this.summary();
    };
    this.#stop = store.observe(change);
    if (checkoutOf(this.details)) this.#state = "ready";
    this.summary();
    void this.read();
  }

  get details(): ThreadDetails | undefined {
    return this.#store.thread?.details;
  }
  get owner(): ChangesOwner {
    return this.#owner;
  }
  get store(): WorkStore {
    return this.#store;
  }
  /** Why a branch switch, or a move into a worktree, can't run now. */
  get reasons() {
    return checkoutMoveReasons({
      status: this.#store.thread?.status.state,
      checkout: checkoutOf(this.details),
      state: this.#state,
    });
  }

  /** Reads the checkout again; the daemon also publishes it to the thread's live details. */
  async read(): Promise<void> {
    if (!checkoutOf(this.details)) this.#state = "loading";
    this.summary();
    try {
      const reply = await this.#owner.request({
        type: "workspace.request",
        operation: { op: "thread.details", threadId: ThreadId.parse(this.threadId) },
      });
      if (this.#closed) return;
      if (reply.result.kind === "error") throw new Error(reply.result.code);
      const details = reply.result.kind === "details" ? reply.result.details : undefined;
      this.#state = checkoutOf(details) || checkoutOf(this.details) ? "ready" : "none";
      this.#error = "";
    } catch (error) {
      if (this.#closed) return;
      // The live details may still describe the checkout; the read failing doesn't unsay them.
      if (!checkoutOf(this.details)) {
        this.#state = "error";
        this.#error = actionErrorText(error instanceof Error ? error.message : undefined);
      }
    }
    this.summary();
  }

  /** The project's branches, default first, for the branch picker. */
  async branches(): Promise<void> {
    const workspaceId = this.#store.thread?.workspaceId;
    if (!workspaceId) return;
    this.#branches = { state: "loading", names: this.#branches?.names ?? [], truncated: false };
    this.#putBranches();
    try {
      const reply = await this.#owner.request({
        type: "workspace.request",
        operation: { op: "branches.list", workspaceId: WorkspaceId.parse(workspaceId) },
      });
      if (this.#closed) return;
      this.#branches =
        reply.result.kind === "branches"
          ? {
              state: "ready",
              names: defaultFirst(reply.result.branches),
              truncated: reply.result.truncated,
            }
          : { state: "error", names: [], truncated: false };
    } catch {
      if (this.#closed) return;
      this.#branches = { state: "error", names: [], truncated: false };
    }
    this.#putBranches();
  }

  close(): void {
    this.#closed = true;
    this.#stop();
    this.#sink.clear("work:");
  }

  summary(): void {
    if (this.#closed) return;
    this.#sink.put("work:summary", () => {
      const details = this.details;
      const checkout = checkoutOf(details);
      const problem = checkoutProblem(details);
      const reasons = this.reasons;
      const text = (value: string | undefined, limit: number) =>
        value ? this.#preview(value, limit) : "";
      return {
        type: "work.summary",
        threadId: this.threadId,
        epoch: this.epoch,
        state: this.#state,
        error: this.#error,
        // A chat's folder is not a repository (ADR 0099): no branch, no pull request.
        chat: details?.workspace?.kind === "chat",
        project: text(details?.workspace?.name, 256),
        machine: text(details?.machine?.name, 256),
        path: text(details?.worktree ?? details?.workspace?.path, 1024),
        mode: checkout?.mode ?? null,
        branch: checkout ? text(checkout.branch ?? "detached HEAD", 256) : "",
        baseBranch: text(checkout?.baseBranch, 256),
        note: text(checkout && checkoutNote(checkout), 256),
        switchReason: reasons.switchReason ?? null,
        worktreeReason: reasons.worktreeReason ?? null,
        prs: (details?.linkedPrs ?? []).slice(0, 20).map((pr) => ({
          id: `${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}#${pr.number}`,
          number: pr.number,
          title: text(pr.title, 256),
          state: pr.state,
          summary: prSummary(pr, linkedPrProblem(pr)),
          stale: linkedPrProblem(pr) !== undefined,
          url: text(pr.url, 4096),
          repo: text(`${pr.repo.owner}/${pr.repo.name}`, 256),
          owner: pr.repo.owner,
          name: pr.repo.name,
        })),
        morePrs: Math.max(0, (details?.linkedPrs?.length ?? 0) - 20),
        problem: problem
          ? {
              kind: problem.kind,
              label: problem.label,
              detail: text(problem.detail, 512),
              failed: problem.failed,
              // The newest lines, which say why it stopped.
              output: problem.output.slice(-40).map((line) => this.#preview(line, 1024)),
              actions: problem.actions.map(problemAction),
            }
          : null,
        locked: lockedOf(this.#store),
        busy: this.busy,
      };
    });
  }

  #putBranches(): void {
    this.#sink.put("work:branches", () => {
      const branches = this.#branches;
      if (!branches) return undefined;
      return {
        type: "work.branches",
        threadId: this.threadId,
        epoch: this.epoch,
        state: branches.state,
        names: branches.names.slice(0, 500).map((name) => this.#preview(name, 256)),
        truncated: branches.truncated || branches.names.length > 500,
      };
    });
  }
}
