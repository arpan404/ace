import type { ClientApi } from "@ace/client";
import {
  WorktreeCreations,
  type WorktreeAction,
  type WorktreeCreationState,
} from "@ace/client/worktree-creations";
import {
  worktreeActionOrder,
  worktreeActionWords,
  worktreeHeadline,
  worktreeNote,
  worktreeRefusalWords,
  worktreeSpeaks,
  worktreeStepRows,
} from "@ace/ui-core";
import type { PatchSink, Preview } from "./agents.ts";

/*
 * A new thread's worktree as it is made, for the phone (the web's `WorktreeCreationCard`): one
 * `compose.worktree` patch per start, keyed by its command id, with the heading, a line per step
 * reached, why it stopped, the daemon's redacted log and the actions it offers now. The card is
 * null until the daemon reports, once the worktree is made (the thread opens instead), and when
 * the start was refused for the message's own reason. Progress, actions and reconnects are the
 * SDK's (`WorktreeCreations`); the words are the shared ones.
 */

export type WorktreeOwner = Pick<
  ClientApi,
  "request" | "onMessage" | "connectionState" | "connectionGeneration"
>;

/** The newest lines of the daemon's log the phone keeps on the card. */
const detailLines = 200;

function made(state: WorktreeCreationState): string | null {
  const progress = state.progress;
  return progress && (progress.state === "done" || progress.state === "local")
    ? (progress.threadId ?? null)
    : null;
}

export class WorktreeStarts {
  readonly #store: WorktreeCreations;
  readonly #sink: PatchSink;
  readonly #preview: Preview;
  /** Each start followed, and the refusal its receipt gave, if any. */
  readonly #followed = new Map<string, { stop: () => void; code: string | undefined }>();

  constructor(owner: WorktreeOwner, sink: PatchSink, preview: Preview) {
    this.#store = new WorktreeCreations(owner);
    this.#sink = sink;
    this.#preview = preview;
  }

  /** Follow a worktree start sent under `commandId`. */
  follow(commandId: string): void {
    if (this.#followed.has(commandId)) return;
    const selection = this.#store.state(commandId);
    const entry = { stop: () => {}, code: undefined as string | undefined };
    this.#followed.set(commandId, entry);
    entry.stop = selection.subscribe(() => this.#emit(commandId, selection.getSnapshot()));
    this.#emit(commandId, selection.getSnapshot());
  }

  /** The start's receipt arrived: a refusal for the message's own reason quiets its card. */
  settled(commandId: string, code: string | undefined): void {
    const entry = this.#followed.get(commandId);
    if (!entry) return;
    entry.code = code;
    this.#emit(commandId, this.#store.state(commandId).getSnapshot());
  }

  act(commandId: string, action: WorktreeAction): void {
    if (this.#followed.has(commandId)) void this.#store.act(commandId, action);
  }

  close(): void {
    for (const entry of this.#followed.values()) entry.stop();
    this.#followed.clear();
    this.#store.close();
  }

  #emit(commandId: string, state: WorktreeCreationState): void {
    const code = this.#followed.get(commandId)?.code;
    this.#sink.put(`compose:worktree:${commandId}`, () => ({
      type: "compose.worktree",
      id: commandId,
      card: this.#card(state, code),
      /** The thread made in it (or on the local checkout instead), to open; null until then. */
      made: made(state),
    }));
  }

  #card(state: WorktreeCreationState, code: string | undefined) {
    const progress = state.progress;
    if (!progress || progress.state === "done" || progress.state === "local") return null;
    if (!worktreeSpeaks(progress, code)) return null;
    const preview = this.#preview;
    return {
      headline: preview(worktreeHeadline(progress), 256),
      running: progress.state === "running" || progress.state === "cancelling",
      failed: progress.state === "failed",
      steps: worktreeStepRows(progress).map((row) => ({
        label: row.label,
        state: row.state,
        elapsedMs: row.elapsedMs,
        percent: row.percent ?? null,
      })),
      note: preview(worktreeNote(progress) ?? "", 1024),
      refused: state.refused ? worktreeRefusalWords[state.refused] : "",
      /** A stale Git lock stopped it: Clear stale lock is the web's way on, from the computer. */
      locked: progress.state === "failed" && progress.error === "git_quarantined",
      actions: worktreeActionOrder
        .filter((action) => progress.actions.includes(action))
        .map((action) => ({
          id: action,
          label:
            state.sending === action
              ? worktreeActionWords[action].busy
              : worktreeActionWords[action].label,
        })),
      sending: state.sending ?? "",
      details: progress.details.slice(-detailLines).map((line) => preview(line, 1024)),
    };
  }
}
