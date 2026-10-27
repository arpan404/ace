import { readServerQueue, type ClientCore, type ThreadSource } from "@ace/client";
import { CommandId, type CommandPayload, type QueuePage, type ThreadId } from "@ace/protocol";
import {
  queueActionPayload,
  queueMoveAfter,
  queuedInputLine,
  type QueueAction,
} from "@ace/ui-core";
import { preview } from "./presentation.ts";
import { queueHold, textOf } from "./queue-hold.ts";
import { queuedFiles } from "./take-back.ts";

/*
 * Follow-ups waiting in the daemon's queue. A queued send joins the transcript only when it is
 * delivered, so the phone reads the queue itself (the web's `readServerQueue`) whenever the
 * reader's queue revision moves, and offers the daemon's own edits: change the words, send it
 * now as a steer, move it up or down, or remove it. Every edit is fenced to the revision the person saw.
 * It also says what holds the queue (`queue-hold.ts`) and runs the queue-wide choices: Pause,
 * Resume, a limit's Resume at reset, Continue. The list shows a page at a time; Show more lists
 * the next (every message is already read, so each can be acted on).
 */

/** Messages listed at first, and how many more each Show more adds. */
export const queueStep = 32;
type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

export class QueueFollower {
  readonly #client: ClientCore;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #signal: AbortSignal;
  readonly #put: Put;
  readonly #counted: (count: number, held: boolean) => void;
  readonly #now: () => number;
  #page: QueuePage | undefined;
  #reading: number | undefined;
  #shown = queueStep;

  constructor(
    client: ClientCore,
    store: ThreadSource,
    threadId: ThreadId,
    signal: AbortSignal,
    put: Put,
    counted: (count: number, held: boolean) => void = () => {},
    now: () => number = () => 0,
  ) {
    this.#now = now;
    this.#client = client;
    this.#store = store;
    this.#threadId = threadId;
    this.#signal = signal;
    this.#put = put;
    this.#counted = counted;
  }

  /** The reader changed: read again when the queue's revision moved, else reword the line. */
  update(): void {
    const revision = this.#store.queue?.revision;
    if (revision !== undefined && revision !== this.#page?.revision && revision !== this.#reading)
      void this.#read(revision);
    this.#emit();
  }

  /** A queue command for one message the person saw, or undefined when it has moved on. */
  edit(
    messageId: string,
    change:
      | { kind: "remove" }
      | { kind: "steer" }
      | { kind: "words"; text: string }
      | { kind: "move"; step: -1 | 1 },
  ): CommandPayload | undefined {
    const page = this.#page;
    const message = page?.messages.find((entry) => entry.id === messageId);
    if (!page || !message) return undefined;
    const target = {
      threadId: this.#threadId,
      expectedRevision: page.revision,
      messageId: CommandId.parse(messageId),
    };
    if (change.kind === "remove") return { type: "queue.remove", ...target };
    if (change.kind === "move") {
      const ids: string[] = page.messages.map((entry) => entry.id);
      const after = queueMoveAfter(ids, ids.indexOf(message.id), change.step);
      if (after === undefined) return undefined;
      return {
        type: "queue.move",
        ...target,
        after: after === null ? null : CommandId.parse(after),
      };
    }
    if (change.kind === "steer")
      return { type: "queue.edit", ...target, input: message.input, delivery: "steer" };
    const text = change.text.trim();
    if (!text) return undefined;
    // New words replace the text; images, files and mentions stay with the message.
    const kept = message.input.filter((part) => part.type !== "text");
    return {
      type: "queue.edit",
      ...target,
      input: [{ type: "text", text }, ...kept],
      ...(message.context ? { context: message.context } : {}),
    };
  }

  /** List the next page of waiting messages. */
  more(): void {
    this.#shown += queueStep;
    this.#emit();
  }

  /**
   * The command for a queue-wide choice (Pause, Resume, Continue, a limit's choice), fenced to
   * the queue as the daemon has it now, not as it was last read: another device may have moved it.
   */
  async act(action: QueueAction): Promise<CommandPayload | undefined> {
    const { queue } = await this.#client.request(
      { type: "queue.get", threadId: this.#threadId, limit: 1 },
      { signal: this.#signal },
    );
    return queueActionPayload(action, this.#threadId, queue);
  }

  async #read(revision: number): Promise<void> {
    this.#reading = revision;
    let failed = false;
    try {
      const page = await readServerQueue(
        this.#threadId,
        async (request) =>
          (await this.#client.request({ type: "queue.get", ...request }, { signal: this.#signal }))
            .queue,
      );
      if (this.#signal.aborted) return;
      this.#page = page;
      this.#emit();
    } catch {
      // Offline, or the queue moved while paging: the reader's next change reads again.
      failed = true;
    } finally {
      if (this.#reading === revision) this.#reading = undefined;
      // A revision that arrived during the read is read now. Not after a failure: a request that
      // fails at once (before the socket is ready) would read again at once, forever, and starve
      // everything else on the JavaScript thread, the socket's own handshake included.
      const latest = this.#store.queue?.revision;
      if (
        !failed &&
        !this.#signal.aborted &&
        latest !== undefined &&
        latest !== this.#page?.revision
      )
        this.update();
    }
  }

  #emit(): void {
    const page = this.#page;
    const hold = queueHold(this.#store, page, this.#now());
    // The message that wasn't sent is the transcript's, not queued work.
    const messages = (page?.messages ?? []).filter((message) => message.id !== hold.head);
    this.#counted(messages.length, hold.strip?.kind === "limit");
    this.#put("queue", () => {
      const thread = this.#store.thread;
      const root = thread?.rootAgentId ? this.#store.agent(thread.rootAgentId) : undefined;
      const line = queuedInputLine({
        retained: page?.messages.length ?? 0,
        queue: this.#store.queue ?? page,
        status: thread?.status,
        agentFailed: root?.status.state === "failed",
      });
      return {
        type: "thread.queue",
        revision: page?.revision ?? 0,
        label: line?.label ?? "",
        when: line?.when ?? "",
        messages: messages.slice(0, this.#shown).map((message) => ({
          id: message.id,
          text: preview(textOf(message), 512),
          delivery: message.delivery,
          state: message.state,
          attachments: queuedFiles(message),
        })),
        more: Math.max(0, messages.length - this.#shown),
        control: hold.control,
        strip: hold.strip,
        notSent: hold.notSent,
      };
    });
  }
}
