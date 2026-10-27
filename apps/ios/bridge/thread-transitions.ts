import type { ClientCore, ThreadSource } from "@ace/client";
import {
  ItemId,
  ThreadId,
  maxMessageBytes,
  type CommandPayload,
  type MessageContext,
} from "@ace/protocol";
import {
  choiceSelection,
  continuationAttachmentProblem,
  forkBudgetBytes,
  forkInput,
  mergeAnswerOf,
  mergeSummaryOf,
  resendPayload,
  retryPointOf,
  type ModelChoice,
} from "@ace/ui-core";
import { runsOn } from "@ace/ui-core/thread-execution";
import { forkStart, transitionsRow, type ForkAt, type ForkStart } from "./message-actions.ts";

/*
 * The open thread's transitions from its messages and menu (ADR 0051), as the web makes them:
 * a fork from an answer, the last turn or before an edited message, written in the thread's own
 * composer and started by its first message on the model picked for it; Pi's rewind and retry in
 * place; and a fork's work brought back to its parent. Payloads are built here from the SDK
 * reader; Swift sends the person's intent only.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
type Admit = (id: string, ok: boolean, message: string) => void;
/** Sends `payload` under `id`; `receipt` hears the daemon's answer. */
type Dispatch = (
  payload: CommandPayload,
  id: string,
  hooks: {
    receipt?(result: { ok: boolean; forkThreadId?: string | undefined }): void;
    unsaved?(): void;
  },
) => void;

/** A fork opened in the composer and not sent yet: where it starts, and the model picked for it. */
export interface ForkDraft extends ForkStart {
  /** Where the composer keeps its words, apart from the thread's own message (`fork:` + point). */
  key: string;
  choice: ModelChoice | undefined;
  sending: boolean;
}

const pointKey = (start: ForkStart) =>
  start.point.type === "turn" ? `run:${start.point.runId}` : `item:${start.point.itemId}`;

/** The fork's first message as `thread.fork`, or why it can't go yet. */
export function forkPayload(request: {
  threadId: ThreadId;
  store: ThreadSource;
  draft: ForkDraft;
  input: string;
  files: readonly { name: string; mimeType?: string | undefined }[];
  modalities: readonly string[] | undefined;
  context: MessageContext | undefined;
}): { payload: CommandPayload } | { refused: string } {
  const checked = forkInput(request.input);
  if ("refused" in checked) return checked;
  const selection = runsOn(request.store.thread);
  const reads = request.draft.choice ?? {
    provider: selection?.provider ?? request.store.thread?.provider ?? "codex",
    model: selection?.model ?? "",
  };
  const problem = continuationAttachmentProblem(request.files, reads, request.modalities);
  if (problem) return { refused: problem };
  const parent = request.store.thread?.title;
  const title = parent ? `${parent} (fork)`.slice(0, 256) : undefined;
  return {
    payload: {
      type: "thread.fork",
      threadId: request.threadId,
      point: request.draft.point,
      input: checked.input,
      budgetBytes: forkBudgetBytes,
      // The thread's own selection forks natively; only a different pick is sent.
      ...(request.draft.choice
        ? { selection: { ...choiceSelection(request.draft.choice), options: {} } }
        : {}),
      ...(title ? { title } : {}),
      ...(request.context ? { context: request.context } : {}),
    },
  };
}

export class ThreadTransitions {
  readonly #client: ClientCore;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #put: Put;
  /** The history window the person reads, which may hold a message the tail no longer does. */
  readonly #reading: () => ThreadSource | undefined;
  readonly #changed: () => void;
  #draft: ForkDraft | undefined;
  #shown = "";

  constructor(
    client: ClientCore,
    store: ThreadSource,
    threadId: ThreadId,
    io: { put: Put; reading: () => ThreadSource | undefined; changed: () => void },
  ) {
    this.#client = client;
    this.#store = store;
    this.#threadId = threadId;
    this.#put = io.put;
    this.#reading = io.reading;
    this.#changed = io.changed;
  }

  get draft(): ForkDraft | undefined {
    return this.#draft;
  }

  /**
   * A whole new pass over the thread (a snapshot, a reconnect): native dropped what it held for
   * the thread, so the row and any open fork go again even though they haven't changed.
   */
  resend(): void {
    this.#shown = "";
    this.update();
    if (this.#draft) this.#publish();
  }

  /** The thread moved: what its menu and messages offer is worked out again, sent when it changed. */
  update(): void {
    const row = transitionsRow(this.#store);
    const shown = JSON.stringify(row);
    if (shown === this.#shown) return;
    this.#shown = shown;
    this.#put("transitions", () => ({
      type: "thread.transitions",
      ...transitionsRow(this.#store),
    }));
  }

  /** The composer writes a fork from `at`; the strip above it names where from. */
  open(at: ForkAt, id: string, admit: Admit): void {
    if (this.#draft?.sending)
      return admit(id, false, "Still starting the fork. Wait for it to open.");
    const reading = this.#reading();
    const start = forkStart(reading ? [this.#store, reading] : [this.#store], at);
    if ("refused" in start) return admit(id, false, start.refused);
    this.#draft = {
      ...start,
      key: `fork:${this.#threadId}:${pointKey(start)}`,
      choice: undefined,
      sending: false,
    };
    this.#publish();
    admit(id, true, "");
  }

  cancel(): void {
    if (!this.#draft || this.#draft.sending) return;
    this.#draft = undefined;
    this.#publish();
  }

  /** A model picked for the fork; undefined forks on what the thread runs. */
  choose(choice: ModelChoice | undefined): void {
    if (!this.#draft) return;
    this.#draft = { ...this.#draft, choice };
    this.#publish();
  }

  /**
   * Starts the fork with its first message. The words and files stay in the composer until the
   * daemon has started it; the app opens it then (`thread.continued`).
   */
  send(
    request: Omit<Parameters<typeof forkPayload>[0], "threadId" | "store" | "draft">,
    id: string,
    dispatch: Dispatch,
    admit: Admit,
    sent: () => void,
  ): void {
    const draft = this.#draft;
    if (!draft) return admit(id, false, "The fork was closed. Open it again.");
    if (draft.sending) return admit(id, false, "Still starting the fork. Wait for it to open.");
    const built = forkPayload({ ...request, threadId: this.#threadId, store: this.#store, draft });
    if ("refused" in built) return admit(id, false, built.refused);
    this.#draft = { ...draft, sending: true };
    const settle = (started: boolean) => {
      if (this.#draft?.key !== draft.key) return;
      this.#draft = started ? undefined : { ...draft, sending: false };
      this.#publish();
    };
    dispatch(built.payload, id, {
      unsaved: () => settle(false),
      receipt: (result) => {
        settle(result.ok);
        if (!result.ok) return;
        sent();
        const opened = result.forkThreadId;
        if (opened) this.#put("continued", () => ({ type: "thread.continued", id, opened }));
      },
    });
  }

  /**
   * Pi goes back to just before the message that asked for answer `answerId` and asks it again,
   * in place. Only the newest answer of a settled Pi thread retries.
   */
  async retry(answerId: string, id: string, dispatch: Dispatch, admit: Admit): Promise<void> {
    const root = this.#store.thread?.rootAgentId;
    const point = retryPointOf(this.#store, answerId, root);
    const entry = this.#piReady() ? point?.point.piEntry : undefined;
    const payload = point && resendPayload(this.#threadId, this.#store.item(point.askId));
    if (!entry || !payload) return admit(id, false, "This answer can't be retried now.");
    if (!(await this.#rewind(entry)))
      return admit(id, false, "Couldn't go back to before this answer. Try again.");
    dispatch(payload, id, {});
  }

  /** Pi continues from answer `itemId`: later turns stay on screen; Pi won't use them. */
  async rewind(itemId: string, id: string, admit: Admit): Promise<void> {
    const item = this.#store.item(itemId) ?? this.#reading()?.item(itemId);
    const entry = item?.type === "message" && item.role === "assistant" ? item.nativeId : undefined;
    if (!entry || !this.#piReady()) return admit(id, false, "Wait for all agents to finish.");
    const ok = await this.#rewind(entry);
    admit(id, ok, ok ? "" : "Couldn't rewind. Try again.");
  }

  /** What bringing this fork back starts with: its newest own answer, as the summary. */
  mergeDraft(): void {
    const answer = mergeAnswerOf(this.#store, this.#store.thread?.rootAgentId);
    this.#put("mergeDraft", () => ({
      type: "thread.mergeDraft",
      ready: answer !== undefined,
      summary: mergeSummaryOf(answer, maxMessageBytes),
    }));
  }

  /** Sends the summary (and the fork's uncommitted changes, when asked) to the parent. */
  async merge(
    summary: string,
    includeCode: boolean,
    id: string,
    dispatch: Dispatch,
    admit: Admit,
  ): Promise<void> {
    const answer = mergeAnswerOf(this.#store, this.#store.thread?.rootAgentId);
    const words = summary.trim();
    if (!this.#store.thread?.lineage?.parentThreadId || !answer || !words)
      return admit(id, false, "Wait for an answer in this fork before bringing results back.");
    let patch: string | undefined;
    if (includeCode) {
      const read = await this.#patch();
      if ("refused" in read) return admit(id, false, read.refused);
      patch = read.patch;
    }
    dispatch(
      {
        type: "thread.merge",
        threadId: this.#threadId,
        summary: words,
        citations: [{ threadId: this.#threadId, itemId: ItemId.parse(answer.id) }],
        ...(patch ? { patch } : {}),
      },
      id,
      {},
    );
  }

  #piReady(): boolean {
    const row = transitionsRow(this.#store);
    return row.pi && row.settled;
  }
  async #rewind(entryId: string): Promise<boolean> {
    try {
      const reply = await this.#client.request({
        type: "pi.control",
        threadId: this.#threadId,
        operation: { kind: "rollback", entryId },
      });
      return reply.result.ok;
    } catch {
      return false;
    }
  }
  async #patch(): Promise<{ patch: string } | { refused: string }> {
    try {
      const reply = await this.#client.request({
        type: "workspace.request",
        operation: { op: "git.diff", threadId: ThreadId.parse(this.#threadId) },
      });
      if (reply.result.kind !== "gitDiff") return { refused: "Couldn't read this fork's changes." };
      const { patch, truncated } = reply.result;
      if (truncated || new TextEncoder().encode(patch).byteLength > 65536)
        return { refused: "The changes are too large to bring back. Send the summary alone." };
      if (!patch) return { refused: "This fork has no uncommitted changes to include." };
      return { patch };
    } catch {
      return { refused: "Couldn't read this fork's changes. Reconnect and try again." };
    }
  }
  #publish(): void {
    const draft = this.#draft;
    this.#put("fork", () => ({
      type: "thread.fork",
      draft: draft
        ? {
            key: draft.key,
            from: draft.from,
            prefill: draft.prefill,
            sending: draft.sending,
            model: draft.choice ? draft.choice.model : "",
            provider: draft.choice ? draft.choice.provider : "",
          }
        : null,
    }));
    this.#changed();
  }
}
