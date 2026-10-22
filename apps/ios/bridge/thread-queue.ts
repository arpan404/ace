import { readServerQueue, type ClientCore, type ThreadSource } from "@ace/client";
import { CommandId, type CommandPayload, type QueuePage, type ThreadId } from "@ace/protocol";
import { queueMoveAfter, queuedInputLine } from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * Follow-ups waiting in the daemon's queue. A queued send joins the transcript only when it is
 * delivered, so the phone reads the queue itself (the web's `readServerQueue`) whenever the
 * reader's queue revision moves, and offers the daemon's own edits: change the words, send it
 * now as a steer, move it up or down, or remove it. Every edit is fenced to the revision the person saw.
 */

const shown = 32;
type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

const textOf = (message: QueuePage["messages"][number]) =>
  message.input
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

export class QueueFollower {
  readonly #client: ClientCore;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #signal: AbortSignal;
  readonly #put: Put;
  #page: QueuePage | undefined;
  #reading: number | undefined;

  constructor(
    client: ClientCore,
    store: ThreadSource,
    threadId: ThreadId,
    signal: AbortSignal,
    put: Put,
  ) {
    this.#client = client;
    this.#store = store;
    this.#threadId = threadId;
    this.#signal = signal;
    this.#put = put;
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
    this.#put("queue", () => {
      const page = this.#page;
      const thread = this.#store.thread;
      const root = thread?.rootAgentId ? this.#store.agent(thread.rootAgentId) : undefined;
      const line = queuedInputLine({
        retained: page?.messages.length ?? 0,
        queue: this.#store.queue ?? page,
        status: thread?.status,
        agentFailed: root?.status.state === "failed",
      });
      const messages = page?.messages ?? [];
      return {
        type: "thread.queue",
        revision: page?.revision ?? 0,
        label: line?.label ?? "",
        when: line?.when ?? "",
        messages: messages.slice(0, shown).map((message) => ({
          id: message.id,
          text: preview(textOf(message), 512),
          delivery: message.delivery,
          state: message.state,
          attachments: message.input.filter((part) => part.type !== "text").length,
        })),
        more: Math.max(0, messages.length - shown),
      };
    });
  }
}
