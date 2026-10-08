import { CommandId, type WorktreeCreationProgress } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { Notifications, type Selection } from "./observable.ts";

/*
 * The worktree a new thread is being created in, as this device sees it
 * (docs/daemon/worktree-creation.md): the daemon pushes `worktree.creation.progress` for the
 * creates this device sent, keyed by their command id, and answers `get` with the retained
 * progress after a reload or reconnect. Cancel, Retry and the local checkout go back as
 * `worktree.creation.request`.
 */

export type WorktreeAction = "cancel" | "local" | "retry";
/** Why the daemon turned an action down, or "offline" when it couldn't be asked. */
export type WorktreeRefusal =
  | "not_found"
  | "forbidden"
  | "busy"
  | "cleanup_required"
  | "settled"
  | "offline";

export interface WorktreeCreationState {
  /** The newest progress the daemon reported; undefined until it has said anything. */
  progress: WorktreeCreationProgress | undefined;
  /** An action on its way to the daemon. */
  sending: WorktreeAction | undefined;
  /** Why the last action didn't happen. */
  refused: WorktreeRefusal | undefined;
}

const nothing: WorktreeCreationState = {
  progress: undefined,
  sending: undefined,
  refused: undefined,
};

const settledStates = new Set<WorktreeCreationProgress["state"]>([
  "cancelled",
  "failed",
  "done",
  "local",
]);

/** The creation reached an end: made, fallen back to the local checkout, failed or cancelled. */
export const isSettled = (progress: WorktreeCreationProgress): boolean =>
  settledStates.has(progress.state);

const stage = (progress: WorktreeCreationProgress) =>
  isSettled(progress) ? 2 : progress.state === "cancelling" ? 1 : 0;

/**
 * Whether `next` is newer than `shown`: a later attempt, else a later stage of the same one
 * (an end never goes back to running), else a report made no earlier. A push and a `get` reply
 * can cross on the wire; the older one is dropped.
 */
export function supersedes(
  next: WorktreeCreationProgress,
  shown: WorktreeCreationProgress | undefined,
): boolean {
  if (!shown) return true;
  if (next.attempt !== shown.attempt) return next.attempt > shown.attempt;
  if (stage(next) !== stage(shown)) return stage(next) > stage(shown);
  return next.elapsedMs >= shown.elapsedMs;
}

/** The daemon retains at most 16 unresolved creates; settled ones beyond this are forgotten. */
const retained = 32;

export class WorktreeCreations {
  private client: Pick<ClientApi, "request" | "onMessage" | "connectionState">;
  private states = new Map<string, WorktreeCreationState>();
  private watched = new Map<string, number>();
  private notifications = new Notifications(256);
  private stops: (() => void)[] = [];

  constructor(client: Pick<ClientApi, "request" | "onMessage" | "connectionState">) {
    this.client = client;
    try {
      this.stops.push(
        client.onMessage((message) => {
          if (message.type !== "worktree.creation.progress") return;
          const { type: _type, ...progress } = message;
          this.accept(progress);
        }),
      );
    } catch {
      // At the listener limit progress arrives only through `get`, after each reconnect.
    }
    const connection = client.connectionState();
    let ready = connection.getSnapshot() === "ready";
    this.stops.push(
      connection.subscribe(() => {
        const now = connection.getSnapshot() === "ready";
        // Back after a drop: what happened meanwhile, for every create still on screen.
        if (now && !ready) for (const id of this.watched.keys()) this.refresh(id);
        ready = now;
      }),
    );
  }

  /** One create's state. Subscribing asks the daemon for its retained progress. */
  state(commandId: string): Selection<WorktreeCreationState> {
    const selection = this.notifications.select([commandId], () => this.read(commandId));
    return {
      getSnapshot: selection.getSnapshot,
      subscribe: (listener) => {
        const stop = selection.subscribe(listener);
        const count = this.watched.get(commandId) ?? 0;
        this.watched.set(commandId, count + 1);
        if (count === 0) this.refresh(commandId);
        return () => {
          stop();
          const left = (this.watched.get(commandId) ?? 1) - 1;
          if (left > 0) this.watched.set(commandId, left);
          else this.watched.delete(commandId);
        };
      },
    };
  }

  /** Cancel, Retry or the local checkout; one at a time per create. */
  async act(commandId: string, action: WorktreeAction): Promise<void> {
    if (this.read(commandId).sending) return;
    this.patch(commandId, { sending: action, refused: undefined });
    let refused: WorktreeRefusal | undefined;
    try {
      const reply = await this.client.request({
        type: "worktree.creation.request",
        commandId: CommandId.parse(commandId),
        action,
      });
      if (reply.progress) this.accept(reply.progress);
      if (!reply.ok) refused = reply.error ?? "not_found";
    } catch {
      refused = "offline";
    }
    this.patch(commandId, { sending: undefined, refused });
  }

  close(): void {
    for (const stop of this.stops.splice(0)) stop();
  }

  private read(commandId: string): WorktreeCreationState {
    return this.states.get(commandId) ?? nothing;
  }

  private refresh(commandId: string): void {
    if (this.client.connectionState().getSnapshot() !== "ready") return;
    let parsed: CommandId;
    try {
      parsed = CommandId.parse(commandId);
    } catch {
      return;
    }
    this.client
      .request({ type: "worktree.creation.request", commandId: parsed, action: "get" })
      .then(
        (reply) => {
          if (reply.ok && reply.progress) this.accept(reply.progress);
        },
        () => {},
      );
  }

  private accept(progress: WorktreeCreationProgress): void {
    const current = this.read(progress.commandId);
    if (!supersedes(progress, current.progress)) return;
    this.patch(progress.commandId, { progress });
  }

  private patch(commandId: string, change: Partial<WorktreeCreationState>): void {
    const next = { ...this.read(commandId), ...change };
    // Re-inserted, so the map stays in order of last change for `trim`.
    this.states.delete(commandId);
    this.states.set(commandId, next);
    this.trim();
    this.notifications.emit([commandId]);
  }

  /** Forget the oldest settled creates nobody is looking at. */
  private trim(): void {
    for (const [id, state] of this.states) {
      if (this.states.size <= retained) return;
      if (this.watched.has(id) || state.sending) continue;
      if (state.progress && !isSettled(state.progress)) continue;
      this.states.delete(id);
    }
  }
}
