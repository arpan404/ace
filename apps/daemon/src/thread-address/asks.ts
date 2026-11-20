import type { ItemDraft } from "@ace/core";
import type { Addressee, SpadeRemoteOutcome, ThreadId } from "@ace/protocol";
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
 * the answers back with a long poll, posting each reply in the thread as it comes (ADR 0198).
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
  input: {
    method: string;
    path: string;
    body?: Buffer;
    contentType?: string;
    headers?: Readonly<Record<string, string>>;
  },
  options: { signal: AbortSignal; maxBytes: number },
) => Promise<SpadeAnswer>;

export interface ThreadAsksPorts {
  store: ThreadAskStore;
  /** Spade's API while it answers. */
  spade(): SpadeConnection | undefined;
  call: SpadeCall;
  /**
   * The daemon's signature over a request's body (`ace:thread`, as the inbox's), or undefined
   * when its token can't be read: Spade takes a thread ask only from ace itself.
   */
  sign(body: Buffer): Readonly<Record<string, string>> | undefined;
  /**
   * One inbox request to Spade on another of the person's machines, through the fleet (ADR 0132's
   * `spade` machine call); undefined when this daemon has no fleet.
   */
  remote?(
    hostId: string,
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<SpadeRemoteOutcome>;
  /** Writes one message item on the thread's root agent. */
  post(threadId: ThreadId, key: string, draft: ItemDraft): void;
  /** Starts or ends the thread's background row for an ask. */
  hold(
    threadId: ThreadId,
    task: string,
    hold: { title: string } | { status: "completed" | "failed" | "stopped" },
  ): void;
  /** Marks an ask's background row as waiting on the person, so the thread needs them. */
  waiting(threadId: ThreadId, task: string, waiting: boolean): void;
  title(threadId: ThreadId): string;
  now(): number;
  /** Resolves after `ms`, or when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(message: string, error?: unknown): void;
}

type SpadeTarget = Extract<Addressee, { kind: "bot" | "club" }>;
type Answered = { status: number; text: string } | undefined;

/**
 * Where an ask's Spade is: this machine's, by its own routes, or another machine's, by the inbox
 * ops that carry the same bodies there (`thread_ask`, `thread_answer`, `thread_stop`).
 */
interface SpadeRoute {
  ask(body: Record<string, unknown>): Promise<Answered>;
  answer(key: string, waitMs: number): Promise<Answered>;
  stop(key: string): Promise<Answered>;
}

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
    // A bot that was waiting on the person before a restart still is, until it says otherwise.
    if (ask.state === "waiting") this.ports.waiting(ask.threadId, askTaskPrefix + key, true);
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
    if (!asks.length && !message.devices.length) return;
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
    const route = ask.to.kind === "agent" ? undefined : this.route(ask.to);
    if (ask.delivered && route) {
      const answered = await route.stop(key).catch(() => undefined);
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
    await Promise.allSettled(this.running.values());
  }

  private async loop(key: string): Promise<void> {
    const signal = this.closing.signal;
    let attempt = 0;
    while (!signal.aborted) {
      const ask = this.ports.store.ask(key);
      if (!ask || ask.done || ask.to.kind === "agent") return;
      if (this.ports.now() - ask.createdAt > giveUpMs) {
        const where = ask.to.machine ? ask.to.machine.name : "Spade";
        this.finish(ask, "failed", `${where} couldn't be reached for 7 days.`);
        return;
      }
      const route = this.route(ask.to);
      const began = this.ports.now();
      const step = route
        ? ask.delivered
          ? await this.poll(route, ask, ask.to)
          : await this.deliver(route, ask, ask.to)
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
    route: SpadeRoute,
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
    const answer = await route.ask(body).catch(() => undefined);
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
    route: SpadeRoute,
    ask: AskRow,
    to: SpadeTarget,
  ): Promise<"ok" | "same" | "done" | "unreachable"> {
    const answer = await route.answer(ask.key, pollMs).catch(() => undefined);
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
    // A bot waiting on the person makes the thread need them, as a waiting thread does.
    if ((progress.state === "waiting") !== (ask.state === "waiting"))
      this.ports.waiting(ask.threadId, askTaskPrefix + ask.key, progress.state === "waiting");
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

  /** The way to the ask's Spade now; undefined while it can't be reached from here. */
  private route(to: SpadeTarget): SpadeRoute | undefined {
    const elsewhere = to.machine;
    if (elsewhere) {
      const remote = this.ports.remote;
      if (!remote) return undefined;
      const send = (request: Record<string, unknown>) =>
        remote(elsewhere.id, request, this.closing.signal).then(remoteAnswer);
      return {
        ask: (body) => send({ op: "thread_ask", ...body }),
        answer: (key, waitMs) => send({ op: "thread_answer", key, wait_ms: waitMs }),
        stop: (key) => send({ op: "thread_stop", key }),
      };
    }
    const connection = this.ports.spade();
    if (!connection) return undefined;
    return {
      ask: (body) => this.request(connection, "POST", "/v1/thread-asks", body),
      answer: (key, waitMs) => this.request(connection, "GET", `${path(key)}?wait_ms=${waitMs}`),
      stop: (key) => this.request(connection, "POST", `${path(key)}/stop`),
    };
  }

  private async request(
    connection: SpadeConnection,
    method: "GET" | "POST",
    route: string,
    body?: unknown,
  ): Promise<{ status: number; text: string } | undefined> {
    const timeout = AbortSignal.any([this.closing.signal, AbortSignal.timeout(pollMs + 15_000)]);
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = this.ports.sign(bytes);
    if (!headers) return undefined;
    const answered = await this.ports.call(
      connection,
      {
        method,
        path: route,
        headers,
        ...(body === undefined ? {} : { body: bytes, contentType: "application/json" }),
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

/**
 * Another machine's answer as this machine's Spade would give it. Not reached, lost on the way,
 * or Spade off there: undefined, so the ask waits and tries again (its key keeps it once). That
 * machine saying no: a refusal in its words, so the ask ends.
 */
function remoteAnswer(outcome: SpadeRemoteOutcome): Answered {
  if (outcome.kind === "response")
    return { status: outcome.status, text: JSON.stringify(outcome.body ?? null) };
  if (outcome.code !== "refused" && outcome.code !== "forbidden") return undefined;
  if (outcome.message.startsWith("unavailable:")) return undefined;
  const words = outcome.message.replace(/^[a-z_]+: /, "");
  return { status: 403, text: JSON.stringify({ error: words }) };
}

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
