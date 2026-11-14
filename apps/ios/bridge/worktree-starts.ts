import type { ClientApi, PendingSend } from "@ace/client";
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
 *
 * Every worktree start the SDK's outbox still holds is followed, not only the ones sent since
 * launch, so a card the person swiped away (or a start a relaunch interrupted) can always be
 * opened again from its Unsent row. Once it stopped, Back to New thread takes the message back
 * (`message`) and `dismiss` forgets the start on the daemon; its card then goes.
 */

export type WorktreeOwner = Pick<
  ClientApi,
  "request" | "onMessage" | "connectionState" | "connectionGeneration" | "pendingSends"
>;

type Entry = {
  stop: () => void;
  code: string | undefined;
  message: string;
  workspaceId: string;
  returned: boolean;
};

/** A worktree start's words, as the person wrote them, to take back into New thread. */
function startWords(send: PendingSend): { message: string; workspaceId: string } {
  const payload = send.payload;
  if (payload.type !== "thread.create") return { message: "", workspaceId: "" };
  return {
    message: payload.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    workspaceId: payload.workspaceId,
  };
}

const isWorktreeStart = (send: PendingSend) =>
  send.payload.type === "thread.create" && send.payload.mode === "worktree";

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
  /** Each start followed: the refusal its receipt gave, its words, whether it was taken back. */
  readonly #followed = new Map<string, Entry>();
  readonly #stopOutbox: () => void;

  constructor(owner: WorktreeOwner, sink: PatchSink, preview: Preview) {
    this.#store = new WorktreeCreations(owner);
    this.#sink = sink;
    this.#preview = preview;
    const sends = owner.pendingSends();
    const read = () => {
      for (const send of sends.getSnapshot())
        if (isWorktreeStart(send)) {
          this.follow(send.commandId, startWords(send));
          // A start refused before this launch says why on its outbox entry.
          if (send.state === "failed") this.settled(send.commandId, send.error);
        }
    };
    this.#stopOutbox = sends.subscribe(read);
    read();
  }

  /** Follow a worktree start sent under `commandId`, with the words and project it carries. */
  follow(commandId: string, start: { message: string; workspaceId: string }): void {
    const known = this.#followed.get(commandId);
    if (known) {
      if (!known.message) Object.assign(known, start);
      return;
    }
    const selection = this.#store.state(commandId);
    const entry: Entry = { stop: () => {}, code: undefined, ...start, returned: false };
    this.#followed.set(commandId, entry);
    entry.stop = selection.subscribe(() => this.#emit(commandId, selection.getSnapshot()));
    this.#emit(commandId, selection.getSnapshot());
  }

  /** The start's receipt arrived: a refusal for the message's own reason quiets its card. */
  settled(commandId: string, code: string | undefined): void {
    const entry = this.#followed.get(commandId);
    if (!entry || entry.code === code) return;
    entry.code = code;
    this.#emit(commandId, this.#store.state(commandId).getSnapshot());
  }

  /** A card's action; `dismiss` forgets a stopped start on the daemon, and its card goes. */
  act(commandId: string, action: WorktreeAction): void {
    const entry = this.#followed.get(commandId);
    if (!entry) return;
    void this.#store.act(commandId, action).then(() => {
      const state = this.#store.state(commandId).getSnapshot();
      if (action !== "dismiss" || state.refused) return;
      entry.returned = true;
      this.#emit(commandId, state);
    });
  }

  close(): void {
    this.#stopOutbox();
    for (const entry of this.#followed.values()) entry.stop();
    this.#followed.clear();
    this.#store.close();
  }

  #emit(commandId: string, state: WorktreeCreationState): void {
    const entry = this.#followed.get(commandId);
    this.#sink.put(`compose:worktree:${commandId}`, () => ({
      type: "compose.worktree",
      id: commandId,
      card: entry && !entry.returned ? this.#card(state, entry) : null,
      /** The thread made in it (or on the local checkout instead), to open; null until then. */
      made: made(state),
    }));
  }

  #card(state: WorktreeCreationState, entry: Entry) {
    const progress = state.progress;
    if (!progress || progress.state === "done" || progress.state === "local") return null;
    if (!worktreeSpeaks(progress, entry.code)) return null;
    const stopped = progress.state === "cancelled" || progress.state === "failed";
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
      /** The words the person sent, for Back to New thread. */
      message: preview(entry.message, 100_000),
      /** The project it starts in, for New thread to open on. */
      workspaceId: entry.workspaceId,
      /** It stopped and nothing is on its way: the message can go back to New thread. */
      canReturn: stopped && progress.cleanupComplete && !state.sending,
    };
  }
}
