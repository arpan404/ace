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
  worktreeRefusal,
  worktreeRefusalWords,
  worktreeSpeaks,
  worktreeStepRows,
} from "@ace/ui-core";
import type { PatchSink, Preview } from "./agents.ts";
import type { DismissedSends } from "./dismissed-sends.ts";

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
 * opened again from its Unsent row. Once it stopped, Back to New thread (`giveBack`) takes the
 * message back: only once this phone has saved that its Unsent row is dealt with and the daemon
 * has forgotten the start does its card go. Either failing leaves the card and its row.
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

const finished = "That start has already finished.";

/**
 * A start known to have stopped: its last progress stopped, or its receipt refused it for the
 * worktree's sake. One just sent that the daemon hasn't made yet is neither.
 */
function stoppedStart(state: WorktreeCreationState, code: string | undefined): boolean {
  const progress = state.progress;
  if (progress) return progress.state === "cancelled" || progress.state === "failed";
  return code !== undefined && worktreeRefusal(code);
}

const unsaved = "Couldn't save that on this phone. Your message is still here.";

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
  /** Where the phone keeps the failed sends the person dealt with: Back's Unsent row. */
  readonly #kept: DismissedSends | undefined;

  constructor(owner: WorktreeOwner, sink: PatchSink, preview: Preview, kept?: DismissedSends) {
    this.#store = new WorktreeCreations(owner);
    this.#sink = sink;
    this.#preview = preview;
    this.#kept = kept;
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

  /** A card's action: Cancel, Don't use worktree, Retry or Continue. */
  act(commandId: string, action: Exclude<WorktreeAction, "dismiss">): void {
    if (this.#followed.has(commandId)) void this.#store.act(commandId, action);
  }

  /**
   * Back to New thread on a stopped start, answered on `receipt:<requestId>`. The daemon forgets
   * the start first; a daemon that already has (`not_found`) counts as having taken it. Only
   * then is its Unsent row set aside on this phone and the start taken back, so nothing needs
   * undoing: a refusal or a lost connection changes nothing here, and a save that fails leaves
   * the card with its words for Back again, which then needs only the phone's step. Nothing is
   * sent while another action on the start is still on its way.
   */
  async giveBack(commandId: string, requestId: string): Promise<void> {
    const answer = (message: string) =>
      this.#sink.put(`receipt:${requestId}`, () => ({
        type: "receipt",
        id: requestId,
        ok: !message,
        message,
      }));
    const entry = this.#followed.get(commandId);
    const state = this.#store.state(commandId).getSnapshot();
    if (!entry || entry.returned || !stoppedStart(state, entry.code)) return answer(finished);
    if (state.sending) return answer(worktreeRefusalWords.busy);
    if (!state.gone) {
      const result = await this.#store.act(commandId, "dismiss");
      if (result !== "accepted" && result !== "not_found")
        return answer(worktreeRefusalWords[result]);
    }
    if (!this.#kept || !(await this.#kept.dismiss(commandId))) {
      this.#emit(commandId, this.#store.state(commandId).getSnapshot());
      return answer(unsaved);
    }
    entry.returned = true;
    this.#emit(commandId, this.#store.state(commandId).getSnapshot());
    answer("");
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
      /** The person took the stopped start back to New thread: no refusal to say. */
      returned: entry?.returned ?? false,
    }));
  }

  #card(state: WorktreeCreationState, entry: Entry) {
    const progress = state.progress;
    if (state.gone) return this.#goneCard(state, entry);
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

  /**
   * A start the daemon no longer has, though this phone still holds its words: there is
   * nothing to retry or continue, only Back to New thread, which then needs no daemon. One the
   * receipt refused for the message's own reason says so there instead.
   */
  #goneCard(state: WorktreeCreationState, entry: Entry) {
    if (!stoppedStart(state, entry.code)) return null;
    const preview = this.#preview;
    return {
      headline: "Worktree start gone",
      running: false,
      failed: false,
      steps: [],
      note: "Your computer no longer has this start. Your message is still here.",
      refused: "",
      locked: false,
      actions: [],
      sending: state.sending ?? "",
      details: [],
      message: preview(entry.message, 100_000),
      workspaceId: entry.workspaceId,
      canReturn: !state.sending,
    };
  }
}
