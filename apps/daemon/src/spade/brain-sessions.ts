import {
  Command,
  ThreadId,
  type AgentModelRoster,
  type CommandPayload,
  type CommandResult,
  type Event,
  type SpadeBrainFrame,
  type SpadeBrainTurnRequest,
  type SpadeSubscriptions,
  type ProviderKind,
  type Thread,
  type WorkspaceId,
} from "@ace/protocol";
import { reportedOrTable } from "@ace/provider-kit/access-modes";
import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { commandContext, type CommandContext, type CommandHandler } from "../commands.ts";
import type { Store } from "../store.ts";
import { BrainWatch, providerNames, startFailure } from "./brain-watch.ts";

/** Where Spade's bots' hidden sessions live: Spade's own hidden project (ADR 0121). */
export interface SpadeProject {
  workspaceId: WorkspaceId;
}

export interface SpadeBrainsDeps {
  store: Pick<Store, "statement" | "getThread" | "subscribe" | "recordCommand"> &
    Parameters<typeof commandContext>[0];
  engine: () =>
    | {
        internalHandler: CommandHandler;
        /** The account a launch on `provider` uses when none is named: ace's default. */
        targetInstance(provider: ProviderKind): string;
        /** Commits what providers reported so far. */
        flush?(): Promise<void>;
        /** Drops a thread's hold and continuation (nothing then resumes it by itself). */
        discardRecovery(id: ThreadId): void;
      }
    | undefined;
  /** Spade's project, from its host thread; undefined while Spade is off. */
  project(): SpadeProject | undefined;
  /** The model roster the `models` tool shows, as Spade's host thread sees it. */
  roster(): AgentModelRoster | undefined;
  id(): string;
}

/** Device the brain service's commands are recorded under. */
const device = "ace-agent";

/**
 * Spade's bots thinking with the person's subscriptions (ADR 0133): one hidden provider session
 * per bot, resumed every turn, each turn streamed back to Spade as frames.
 */
export class SpadeBrains {
  private readonly deps: SpadeBrainsDeps;
  constructor(deps: SpadeBrainsDeps) {
    this.deps = deps;
  }

  /** Each running turn's pump, by the bot's thread (see `streamSeq`). */
  private readonly live = new Map<ThreadId, () => number>();

  /**
   * How many frames of the bot's running turn precede a call its CLI makes now: everything the
   * session stored before the call is turned into frames first, so Spade can apply them (a web
   * read that taints the turn) before it admits the call. Undefined with no turn running.
   */
  async streamSeq(threadId: ThreadId): Promise<number | undefined> {
    await this.deps.engine()?.flush?.();
    return this.live.get(threadId)?.();
  }

  /** What a bot can think with: installed, turned on and signed-in providers, per account. */
  subscriptions(): SpadeSubscriptions {
    return subscriptionsFrom(this.deps.roster());
  }

  /**
   * Runs one turn: sends `request` to the bot's session and calls `emit` with each frame, the
   * last being `finished` or `failed`. Aborting `signal` interrupts the CLI's turn.
   */
  async turn(
    request: SpadeBrainTurnRequest,
    signal: AbortSignal,
    emit: (frame: SpadeBrainFrame) => void,
  ): Promise<void> {
    const engine = this.deps.engine();
    const project = this.deps.project();
    if (!engine || !project) {
      emit({ type: "failed", reason: "unavailable", message: "ace isn't ready for Spade yet." });
      return;
    }
    // The account named, else the one ace launches on now: a session on another account is
    // never reused (it is another subscription's context).
    const account = request.account ?? engine.targetInstance(request.provider);
    const existing = this.botThread(request, account);
    const fresh = existing === undefined;
    const threadId = existing?.id ?? ThreadId.parse(this.deps.id());
    const text =
      fresh || request.instructionsChanged
        ? `${request.instructions.trim()}\n\n---\n\n${request.message}`
        : request.message;
    // Subscribed before sending, so no event of the turn is missed.
    const queued: Event[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.deps.store.subscribe((events) => {
      for (const event of events) if (event.threadId === threadId) queued.push(event);
      wake?.();
    });
    const stopped = () => wake?.();
    signal.addEventListener("abort", stopped, { once: true });
    try {
      const payload: CommandPayload = fresh
        ? {
            type: "thread.create",
            threadId,
            workspaceId: project.workspaceId,
            provider: request.provider,
            accountId: account,
            model: request.model,
            access: "read-only",
            mode: "local",
            title: "Spade bot",
            input: [{ type: "text", text }],
          }
        : {
            type: "thread.send",
            threadId,
            input: [{ type: "text", text }],
            delivery: "queue",
            ...(existing.execution?.model === request.model ? {} : { model: request.model }),
          };
      const sendId = this.deps.id();
      const result = this.send(engine.internalHandler, payload, request.bot, sendId);
      const root = this.deps.store.getThread(threadId)?.rootAgentId;
      if (!result.ok || !root) {
        const failed = startFailure(request.provider, result.ok ? undefined : result.error);
        emit({ type: "failed", ...failed });
        return;
      }
      const watch = new BrainWatch(root, request.provider);
      let sent = 0;
      const send = (frame: SpadeBrainFrame) => {
        sent++;
        emit(frame);
      };
      // Turns every event stored so far into frames; returns how many frames went out.
      const pump = () => {
        for (let event = queued.shift(); event && !watch.ended; event = queued.shift()) {
          const frames = watch.next(event.payload);
          // ace held the turn's message after failing to deliver it: let go of it, so nothing
          // sends it later behind Spade's back, and leave the session unheld for the next turn.
          if (
            event.payload.type === "queue.updated" &&
            frames.some((frame) => frame.type === "failed")
          )
            this.release(engine, threadId, event.payload.revision, sendId);
          // A native prompt would wait in a thread nobody sees and hold every later turn: the
          // whole session tree stops before Spade hears why.
          if (
            frames.some((frame) => frame.type === "failed" && frame.reason === "needs_permission")
          )
            this.interrupt(engine.internalHandler, threadId);
          for (const frame of frames) send(frame);
        }
        return sent;
      };
      send({ type: "session", thread: threadId, fresh });
      this.live.set(threadId, pump);
      try {
        while (!watch.ended) {
          if (signal.aborted) {
            this.interrupt(engine.internalHandler, threadId);
            return;
          }
          pump();
          if (watch.ended) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        this.live.delete(threadId);
      }
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", stopped);
    }
  }

  /** The bot's current hidden thread, unless the provider or account changed since. */
  private botThread(request: SpadeBrainTurnRequest, account: string): Thread | undefined {
    const row = this.deps.store
      .statement(
        `SELECT id FROM threads WHERE json_extract(client,'$.host')='spade-bot'
        AND json_extract(client,'$.hostKey')=? AND json_extract(client,'$.deletedAt') IS NULL
        ORDER BY created_at DESC, id LIMIT 1`,
      )
      .get(request.bot) as { id: string } | undefined;
    if (!row) return undefined;
    const thread = this.deps.store.getThread(ThreadId.parse(row.id));
    if (!thread || thread.provider !== request.provider) return undefined;
    const held = thread.execution?.instanceId ?? thread.live?.account;
    const wanted = request.provider === "cursor" ? cursorInstanceId(account) : account;
    if (held !== wanted) return undefined;
    return thread;
  }

  /** Removes Spade's undelivered message from the session's queue and drops its hold. */
  private release(
    engine: { internalHandler: CommandHandler; discardRecovery(id: ThreadId): void },
    threadId: ThreadId,
    revision: number,
    messageId: string,
  ): void {
    const command = Command.parse({
      id: this.deps.id(),
      deviceId: device,
      payload: { type: "queue.remove", threadId, expectedRevision: revision, messageId },
    });
    this.deps.store.recordCommand(command.id, command.deviceId, () =>
      engine.internalHandler.handle(command, commandContext(this.deps.store)),
    );
    engine.discardRecovery(threadId);
  }

  private send(
    handler: CommandHandler,
    payload: CommandPayload,
    bot: string,
    id: string,
  ): CommandResult {
    const command = Command.parse({ id, deviceId: device, payload });
    const context: CommandContext = {
      ...commandContext(this.deps.store),
      host: { host: "spade-bot", key: bot },
    };
    return this.deps.store.recordCommand(command.id, command.deviceId, () =>
      handler.handle(command, context),
    );
  }

  private interrupt(handler: CommandHandler, threadId: ThreadId): void {
    const command = Command.parse({
      id: this.deps.id(),
      deviceId: device,
      payload: { type: "thread.interrupt", threadId, cascade: true },
    });
    this.deps.store.recordCommand(command.id, command.deviceId, () =>
      handler.handle(command, commandContext(this.deps.store)),
    );
  }
}

/**
 * The roster narrowed to what can run now: providers whose CLI is installed and turned on, with
 * their accounts that aren't signed out and their current models. A provider with none of either is left out.
 */
export function subscriptionsFrom(roster: AgentModelRoster | undefined): SpadeSubscriptions {
  const providers = (roster?.providers ?? []).flatMap((entry) => {
    const accounts = entry.accounts
      // A login ace can't read (`unknown`) is listed: a turn on it that finds it signed out
      // ends with one line. Only a known sign-out is left out.
      .filter((a) => a.installed !== false && a.enabled !== false && a.auth !== "logged_out")
      .map((a) => ({ id: a.id, label: a.label ?? null }));
    const models = entry.sets
      .filter((set) => !set.legacy)
      .flatMap((set) => set.ids.map((id) => ({ id, name: set.names?.[id] ?? id })));
    // A bot's session runs read-only or not at all: a provider without that mode isn't offered.
    const readOnly = reportedOrTable(entry.provider, undefined).some(
      (offer) => offer.mode === "read-only",
    );
    if (!readOnly || accounts.length === 0 || models.length === 0) return [];
    return [{ provider: entry.provider, name: providerNames[entry.provider], accounts, models }];
  });
  return { providers };
}
