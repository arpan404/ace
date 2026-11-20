import type { ItemDraft } from "@ace/core";
import type { Addressee, ThreadId } from "@ace/protocol";
import type { SpadeAnswer, SpadeConnection } from "@ace/service/spade";
import { askedLineOf, type AddressedRow, type AskRow, type ThreadAskStore } from "./asks-store.ts";
import {
  askedItemKey,
  askedLineDraft,
  askProgress,
  botRepliesText,
  holdTitle,
  personText,
  replyDraft,
  replyItemKey,
  ThreadAskAnswer,
} from "./plan.ts";

/*
 * Delivers each bot and club ask of an addressed message to Spade once, by its key, and reads
 * the answers back with a long poll, posting each reply in the thread as it comes (ADR 0194).
 * Every ask holds its thread open as one of ace's background tasks until it ends. A restart
 * reads the open asks again from the store; Spade stores each key with its message, so a resend
 * never delivers twice.
 */

/** The background task key of an ask; a stop of it is routed here (`bindExternalTaskStop`). */
export const askTaskPrefix = "ace-ask:";
/** How long an ask waits for Spade to come back before it gives up. */
export const giveUpMs = 7 * 24 * 60 * 60_000;
/** How long each read of an answer waits in Spade. */
const pollMs = 20_000;
const retryMs = (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt, 6), 60_000);

export type SpadeCall = (
  connection: SpadeConnection,
  input: { method: string; path: string; body?: Buffer; contentType?: string },
  options: { signal: AbortSignal; maxBytes: number },
) => Promise<SpadeAnswer>;

export interface ThreadAsksPorts {
  store: ThreadAskStore;
  /** Spade's API while it answers. */
  spade(): SpadeConnection | undefined;
  call: SpadeCall;
  /** Writes one message item on the thread's root agent. */
  post(threadId: ThreadId, key: string, draft: ItemDraft): void;
  /** Starts or ends the thread's background row for an ask. */
  hold(
    threadId: ThreadId,
    task: string,
    hold: { title: string } | { status: "completed" | "failed" | "stopped" },
  ): void;
  title(threadId: ThreadId): string;
  now(): number;
  /** Resolves after `ms`, or when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(message: string, error?: unknown): void;
}

type SpadeTarget = Extract<Addressee, { kind: "bot" | "club" }>;

export class ThreadAsks {
  private ports: ThreadAsksPorts;
  private running = new Map<string, Promise<void>>();
  /** Agents' messages on their way now. */
  private sending = new Set<string>();
  private closing = new AbortController();
  constructor(ports: ThreadAsksPorts) {
    this.ports = ports;
  }
  /** Records the person's message and its asks, then shows it in the thread. */
  record(message: AddressedRow, asks: readonly AskRow[], at: number): void {
    this.ports.store.begin(message, asks, at);
    this.show(message.commandId);
  }
  /** Starts every open ask again: after a restart, or once Spade appears. */
  resume(): void {
    for (const ask of this.ports.store.open()) {
      // A message to an agent that a restart caught before it went is said to be not sent.
      if (ask.to.kind === "agent" && !this.running.has(ask.key) && !this.sending.has(ask.key))
        this.settleAgent(ask.key, { ok: false, error: "restarted" });
      else this.drive(ask.key);
    }
  }
  /** Marks an agent's message sent, or why it wasn't; held open while it goes. */
  sendingTo(key: string): void {
    this.sending.add(key);
  }
  settleAgent(key: string, outcome: { ok: true } | { ok: false; error: string }): void {
    this.sending.delete(key);
    const ask = this.ports.store.ask(key);
    if (!ask || ask.done) return;
    this.ports.store.update(
      key,
      outcome.ok
        ? { state: "sent", done: true }
        : { state: "failed", detail: notSent(outcome.error), done: true },
      this.ports.now(),
    );
    this.show(ask.commandId);
  }
  /** Begins an ask the store already holds. */
  drive(key: string): void {
    if (this.running.has(key) || this.closing.signal.aborted) return;
    const ask = this.ports.store.ask(key);
    if (!ask || ask.done || ask.to.kind === "agent") return;
    this.ports.hold(ask.threadId, askTaskPrefix + key, { title: holdTitle(ask.to) });
    const run = this.loop(key)
      .catch((error: unknown) => this.ports.log("A thread ask stopped unexpectedly", error))
      .finally(() => this.running.delete(key));
    this.running.set(key, run);
  }
  /** Writes the person's message as it stands now: their words and each addressee's state. */
  show(commandId: string): void {
    const message = this.ports.store.message(commandId);
    if (!message) return;
    const asks = this.ports.store.asks(commandId);
    if (!asks.length) return;
    this.ports.post(
      message.threadId,
      askedItemKey(commandId),
      askedLineDraft(askedLineOf(message, asks)),
    );
  }
  /** The person stopped the ask (its background row, or Stop in the thread). */
  async stop(key: string): Promise<void> {
    const ask = this.ports.store.ask(key);
    if (!ask || ask.done) return;
    const connection = this.ports.spade();
    if (ask.delivered && connection) {
      const answered = await this.request(connection, "POST", `${path(key)}/stop`).catch(
        () => undefined,
      );
      // Delivered and still running there: the poll reads Spade's own stop and its words.
      if (answered?.status === 200 && this.running.has(key)) return;
    }
    this.finish(ask, "stopped", undefined);
  }
  /** Stops every open ask of a thread. */
  async stopThread(threadId: ThreadId): Promise<void> {
    const open = this.ports.store.open().filter((ask) => ask.threadId === threadId);
    await Promise.all(open.map((ask) => this.stop(ask.key)));
  }
  /**
   * The replies this thread's agent hasn't been given, as a context item for the person's next
   * message to it; undefined when there are none. Each is given once.
   */
  takeReplies(threadId: ThreadId): { type: "bot_replies"; keys: string[] } | undefined {
    const replies = this.ports.store.takeUngiven(threadId);
    return replies.length
      ? { type: "bot_replies", keys: replies.map((reply) => reply.itemKey) }
      : undefined;
  }
  /** The named replies as the agent reads them: untrusted, framed. */
  repliesText(threadId: ThreadId, keys: readonly string[]): string | undefined {
    const replies = this.ports.store.replies(threadId, keys);
    return replies.length ? botRepliesText(replies) : undefined;
  }
  async close(): Promise<void> {
    this.closing.abort();
    await Promise.allSettled([...this.running.values()]);
  }

  private async loop(key: string): Promise<void> {
    const signal = this.closing.signal;
    let attempt = 0;
    while (!signal.aborted) {
      const ask = this.ports.store.ask(key);
      if (!ask || ask.done || ask.to.kind === "agent") return;
      if (this.ports.now() - ask.createdAt > giveUpMs) {
        this.finish(ask, "failed", "Spade couldn't be reached for 7 days.");
        return;
      }
      const connection = this.ports.spade();
      const began = this.ports.now();
      const step = connection
        ? ask.delivered
          ? await this.poll(connection, ask, ask.to)
          : await this.deliver(connection, ask, ask.to)
        : "unreachable";
      if (step === "ok") {
        attempt = 0;
        continue;
      }
      // Nothing changed: a long poll that came back at once (Spade restarting) waits a moment.
      if (step === "same") {
        if (this.ports.now() - began < 1_000) await this.ports.sleep(1_000, signal);
        continue;
      }
      if (step === "done") return;
      // Spade is off, restarting or busy: the ask waits, and its line says so.
      if (ask.state !== "queued" && !ask.delivered) {
        this.ports.store.update(key, { state: "queued" }, this.ports.now());
        this.show(ask.commandId);
      }
      await this.ports.sleep(retryMs(attempt++), signal);
    }
  }

  private async deliver(
    connection: SpadeConnection,
    ask: AskRow,
    to: SpadeTarget,
  ): Promise<"ok" | "done" | "unreachable"> {
    const message = this.ports.store.message(ask.commandId);
    if (!message) return "done";
    const context = message.pack;
    const body = {
      key: ask.key,
      to: { kind: to.kind, id: to.id },
      text: personText(message.input),
      ...(context ? { context } : {}),
      thread: { id: ask.threadId, title: this.ports.title(ask.threadId).slice(0, 200) },
    };
    const answer = await this.request(connection, "POST", "/v1/thread-asks", body).catch(
      () => undefined,
    );
    if (!answer || answer.status >= 500 || answer.status === 429) return "unreachable";
    if (answer.status !== 200) {
      this.finish(ask, "failed", refusal(answer.text, to));
      return "done";
    }
    this.ports.store.update(ask.key, { delivered: true, state: "answering" }, this.ports.now());
    this.show(ask.commandId);
    return "ok";
  }

  private async poll(
    connection: SpadeConnection,
    ask: AskRow,
    to: SpadeTarget,
  ): Promise<"ok" | "same" | "done" | "unreachable"> {
    const answer = await this.request(
      connection,
      "GET",
      `${path(ask.key)}?wait_ms=${pollMs}`,
    ).catch(() => undefined);
    if (!answer || answer.status !== 200) return "unreachable";
    let parsed: ThreadAskAnswer;
    try {
      parsed = ThreadAskAnswer.parse(JSON.parse(answer.text));
    } catch {
      return "unreachable";
    }
    const message = this.ports.store.message(ask.commandId);
    const progress = askProgress(to, parsed, ask.posted, {
      about: message?.about ?? ask.commandId,
      ask: ask.key,
    });
    progress.replies.forEach((reply, index) => {
      const itemKey = replyItemKey(ask.key, ask.posted + index);
      this.ports.post(ask.threadId, itemKey, replyDraft(reply.text, reply.speaker));
      this.ports.store.saveReply(
        {
          itemKey,
          threadId: ask.threadId,
          bot: reply.speaker.name,
          club: reply.speaker.club?.name,
          text: reply.text,
        },
        this.ports.now(),
      );
    });
    const posted = ask.posted + progress.replies.length;
    // The reply being written streams into the slot the finished reply will take.
    if (progress.writing)
      this.ports.post(
        ask.threadId,
        replyItemKey(ask.key, posted),
        replyDraft(progress.writing.text, progress.writing.speaker, false),
      );
    if (progress.done) {
      this.ports.store.update(ask.key, { posted }, this.ports.now());
      this.finish({ ...ask, posted }, progress.state, progress.detail);
      return "done";
    }
    if (posted !== ask.posted || progress.state !== ask.state || progress.detail !== ask.detail) {
      this.ports.store.update(
        ask.key,
        { posted, state: progress.state, detail: progress.detail },
        this.ports.now(),
      );
      this.show(ask.commandId);
      return "ok";
    }
    return progress.writing ? "ok" : "same";
  }

  private finish(ask: AskRow, state: AskRow["state"], detail: string | undefined): void {
    this.ports.store.update(ask.key, { state, detail, done: true }, this.ports.now());
    this.show(ask.commandId);
    this.ports.hold(ask.threadId, askTaskPrefix + ask.key, {
      status: state === "answered" ? "completed" : state === "stopped" ? "stopped" : "failed",
    });
  }

  private async request(
    connection: SpadeConnection,
    method: "GET" | "POST",
    route: string,
    body?: unknown,
  ): Promise<{ status: number; text: string } | undefined> {
    const timeout = AbortSignal.any([this.closing.signal, AbortSignal.timeout(pollMs + 15_000)]);
    const answered = await this.ports.call(
      connection,
      {
        method,
        path: route,
        ...(body === undefined
          ? {}
          : { body: Buffer.from(JSON.stringify(body)), contentType: "application/json" }),
      },
      { signal: timeout, maxBytes: 4 * 1024 * 1024 },
    );
    return answered.kind === "response"
      ? { status: answered.status, text: answered.body.toString("utf8") }
      : undefined;
  }
}

/** Why a message to an agent didn't go, in the person's words. */
function notSent(error: string): string {
  if (error === "restarted") return "ace restarted before it was sent. Send it again.";
  if (error === "thread_not_found") return "That thread is gone.";
  return "That thread didn't take it. Send it again.";
}

const path = (key: string) => `/v1/thread-asks/${encodeURIComponent(key)}`;

/** Spade's refusal in the person's words: its own when it gave one. */
function refusal(text: string, to: SpadeTarget): string {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && "error" in value) {
      const error = value.error;
      if (typeof error === "string" && error.trim()) return error.trim().slice(0, 300);
    }
  } catch {
    // Not JSON: the generic words below.
  }
  return `Spade couldn't give this to ${to.name}.`;
}
