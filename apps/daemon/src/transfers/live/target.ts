import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  IncomingTransfer,
  PortableHandoff,
  TransferMethod,
  ProviderKind,
  ThreadStatus,
  TransferCommit,
  TransferSessionOutcome,
} from "@ace/protocol";
import { headRef, incomingRef } from "../landing-types.ts";
import type { TransferArchive, TransferGit } from "../ports.ts";
import { sessionCarrier, SessionNotCarried } from "../sessions/index.ts";
import { continueMessage } from "./messages.ts";
import type { ThreadOwnership } from "./ownership.ts";
import { LiveStarts, pendingBatch, type LiveStart } from "./target-rows.ts";
import { turnStart, type ContinueFacts } from "./turn-start.ts";

/** What the receiving machine does for a thread that moved while it worked (ADR 0191). */
export interface LiveTargetPorts {
  starts: LiveStarts;
  ownership: ThreadOwnership;
  git: Pick<TransferGit, "fetchBundle" | "deleteRef">;
  archive: Pick<TransferArchive, "unpackArchive">;
  /** The account a new thread of `provider` uses here, with its home. */
  account(provider: ProviderKind): { instanceId: string; home: string } | undefined;
  /** The folder the new thread runs in: the checkout, or its own worktree. */
  threadCwd(threadId: string): string | undefined;
  threadStatus(threadId: string): ThreadStatus | undefined;
  /** What became of input `commandId` (the continue message) in the thread. */
  continueFate(threadId: string, commandId: string): ContinueFacts;
  adoptSession(
    threadId: string,
    session: { nativeSessionId: string; instanceId: string; action: "resume" | "fork" },
  ): void;
  dropSession(threadId: string): void;
  adoptHandoff(threadId: string, handoff: PortableHandoff, machine: string): void;
  send(threadId: string, key: string, text: string): void;
  /** Sends the thread's held unsent message again (the person's "Try again"), keyed. */
  retryHeld(threadId: string, key: string): void;
  atomic<T>(run: () => T): T;
  /** A line on the thread the person reads, for a start that couldn't happen. */
  notice(threadId: string, text: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string, fields: Record<string, unknown>): void;
}

type Live = NonNullable<TransferCommit["live"]>;

/** Where the final payload is unpacked: `delta.bundle` and `session/`. */
export const finalFolder = (directory: string, transferId: string) =>
  join(directory, `${transferId}.final.d`);

export class LiveTarget {
  private ports: LiveTargetPorts;
  private running = new Set<string>();
  private closed = false;
  constructor(ports: LiveTargetPorts) {
    this.ports = ports;
  }
  state(transferId: string): LiveStart | undefined {
    return this.ports.starts.get(transferId);
  }
  /** Every start a restart left unfinished, in bounded batches until none are left. */
  async *unfinished(): AsyncGenerator<LiveStart> {
    let after = "";
    for (;;) {
      const batch = this.ports.starts.unfinished(after);
      for (const start of batch) yield start;
      const last = batch.at(-1);
      if (!last || batch.length < pendingBatch) return;
      after = last.transferId;
      // A turn of the event loop between batches (ADR 0170).
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  /** Stops watching; a restart finishes the start. */
  close(): void {
    this.closed = true;
  }
  /** Unpacks the final payload, once its digest was checked. */
  async unpack(file: string, folder: string, signal: AbortSignal): Promise<void> {
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await this.ports.archive.unpackArchive(file, folder, { signal });
  }
  /** Fetches what changed after the bulk into the repository the work lands in. */
  async delta(
    folder: string,
    transferId: string,
    commit: TransferCommit,
    path: string,
    held: { directoryFd: number } | undefined,
  ): Promise<void> {
    const bundle = join(folder, "delta.bundle");
    if (!(await present(bundle))) return;
    const head = commit.branch ? `refs/heads/${commit.branch}` : headRef(transferId);
    // A branch that didn't move since the bulk isn't in the delta: Git leaves out excluded tips.
    const moved = commit.head !== commit.live?.bulk?.head;
    const refspecs = [
      ...(moved ? [`+${head}:${commit.branch ? incomingRef(transferId) : head}`] : []),
      ...(commit.changes ? [`+${commit.changes.ref}:${commit.changes.ref}`] : []),
    ];
    if (refspecs.length) await this.ports.git.fetchBundle(path, bundle, refspecs, held);
  }
  /** The bulk's own capture ref, which the landing doesn't know to delete. */
  async tidy(live: Live, path: string): Promise<void> {
    const ref = live.bulk?.changes?.ref;
    if (ref) await this.ports.git.deleteRef(path, ref).catch(() => undefined);
  }
  /**
   * Places the carried session for the new thread and records how its history came. Runs
   * before the thread's setup, which adopts the handoff only for a summary.
   */
  async prepare(input: {
    transferId: string;
    deviceId: string;
    method: TransferMethod;
    threadId: string;
    result: NonNullable<IncomingTransfer["result"]>;
    live: Live;
    folder: string;
  }): Promise<TransferSessionOutcome> {
    const known = this.ports.starts.get(input.transferId);
    if (known) return known.session;
    const session = await this.place(input);
    return this.ports.starts.begin(
      {
        transferId: input.transferId,
        deviceId: input.deviceId,
        method: input.method,
        threadId: input.threadId,
        session,
        result: input.result,
      },
      this.ports.now(),
    ).session;
  }
  /**
   * The sender's call about a transfer whose own row retention dropped: answered from the
   * receipt, so a lost answer is never taken for "no such transfer" and nothing lands twice.
   */
  receipt(transferId: string, deviceId: string): IncomingTransfer | undefined {
    const start = this.ports.starts.get(transferId);
    if (!start || start.deviceId !== deviceId) return undefined;
    return {
      transferId,
      state: start.running === undefined ? "importing" : "completed",
      method: start.method,
      offset: 0,
      ignoredOffset: 0,
      result: start.result,
      live: {
        finalOffset: 0,
        ...(start.running === undefined ? {} : { running: start.running }),
        session: start.session,
      },
    };
  }
  private async place(input: {
    threadId: string;
    live: Live;
    folder: string;
  }): Promise<TransferSessionOutcome> {
    const carried = input.live.session;
    if (!carried) return { kind: "summary", reason: input.live.unsupported ?? "nothing to carry" };
    const carrier = sessionCarrier(carried.provider);
    const account = this.ports.account(carried.provider);
    const cwd = this.ports.threadCwd(input.threadId);
    if (!carrier)
      return { kind: "summary", reason: `${carried.provider} sessions aren't carried yet` };
    if (!account)
      return { kind: "summary", reason: `no ${carried.provider} account on this machine` };
    if (!cwd) return { kind: "summary", reason: "the thread's folder isn't ready" };
    try {
      const placed = await carrier.place({
        home: account.home,
        staged: join(input.folder, "session"),
        session: carried,
        targetCwd: cwd,
      });
      this.ports.adoptSession(input.threadId, { ...placed, instanceId: account.instanceId });
      return { kind: "native" };
    } catch (error) {
      if (!(error instanceof SessionNotCarried)) throw error;
      return { kind: "summary", reason: error.message.slice(0, 256) };
    }
  }
  /**
   * The start can't happen: recorded as not started, with why, and said on the thread there.
   * The sender is then answered that the thread is this machine's and moves on (ADR 0191).
   */
  giveUp(input: {
    transferId: string;
    deviceId: string;
    method: TransferMethod;
    threadId: string;
    result: NonNullable<IncomingTransfer["result"]>;
    from: string;
    reason: string;
  }): void {
    const { ports } = this;
    // One transaction: the start's final state and the line the person reads there.
    ports.atomic(() => {
      const start = ports.starts.get(input.transferId);
      if (start?.running !== undefined) return;
      if (!start)
        ports.starts.begin(
          {
            transferId: input.transferId,
            deviceId: input.deviceId,
            method: input.method,
            threadId: input.threadId,
            session: { kind: "summary", reason: input.reason },
            result: input.result,
          },
          ports.now(),
        );
      ports.starts.started(input.transferId, false, ports.now(), input.reason);
      // Said on the thread when it can be; a thread that can't be read still gets its final state.
      try {
        if (ports.threadStatus(input.threadId))
          ports.notice(
            input.threadId,
            `This thread moved here from ${input.from}, but ${input.reason}. Send a message to carry on.`,
          );
      } catch (error) {
        ports.log("Moved thread's notice not shown", { error: String(error) });
      }
    });
  }
  /** Records that this machine owns the thread; called inside the thread's own transaction. */
  own(input: {
    transferId: string;
    threadId: string;
    live: Live;
    from: { hostId: string; name: string };
  }) {
    this.ports.ownership.change(input.threadId, {
      to: "owned",
      transferId: input.transferId,
      peer: { ...input.from, threadId: input.live.sourceThreadId },
      epoch: input.live.epoch,
      at: this.ports.now(),
    });
  }
  /**
   * Sends the continue message and watches the turn start. A carried session that fails to
   * open is dropped and the turn tried once more with the handoff. Runs once per transfer at a
   * time; a restart runs it again from where it was.
   */
  async start(input: {
    transferId: string;
    live: Live;
    from: string;
    path: string;
    handoff: PortableHandoff;
  }): Promise<void> {
    const { ports } = this;
    const start = ports.starts.get(input.transferId);
    if (!start || start.running !== undefined || this.running.has(input.transferId)) return;
    this.running.add(input.transferId);
    try {
      let session = start.session;
      let attempts = start.attempts;
      const giveUp = (reason: string) =>
        this.giveUp({ ...start, from: input.from, reason, result: start.result });
      // Exactly one continue message, ever. Only a refusal at admission, which makes no message,
      // is tried again, under a fresh id, so its receipt never answers the next try; a restart
      // finds the one that went through by the same id and sends nothing more.
      for (;;) {
        const due = ports.starts.get(input.transferId)?.nextAt ?? 0;
        while (!this.closed && ports.now() < due)
          await ports.sleep(Math.min(due - ports.now(), 1_000));
        if (this.closed) return;
        if (!ports.threadStatus(start.threadId)) return giveUp("the thread was deleted here");
        const path = ports.threadCwd(start.threadId) ?? input.path;
        try {
          ports.send(
            start.threadId,
            continueKey(input.transferId, attempts),
            continueMessage({ from: input.from, path, live: input.live, session }),
          );
          break;
        } catch (error) {
          const next = startRetry(attempts, error);
          if (next.kind === "give_up") return giveUp(next.reason);
          attempts++;
          ports.starts.deferred(input.transferId, ports.now() + next.delayMs, ports.now());
        }
      }
      for (;;) {
        // After a restart that already fell back, the held message is sent again by the same id.
        if (session.reason === fallbackReason) ports.retryHeld(start.threadId, fallbackKey(input));
        const outcome = await this.watch(start.threadId, continueKey(input.transferId, attempts));
        if (outcome === "closed") return;
        if (outcome === "running") {
          ports.starts.started(input.transferId, true, ports.now());
          return;
        }
        if (outcome === "uncertain")
          return giveUp("its first message may not have reached the agent");
        // The thread is this machine's and the person acted on it: final, not started, and
        // nothing said on the thread, which shows what they did.
        if (typeof outcome === "object") {
          ports.starts.started(input.transferId, false, ports.now(), outcome.person);
          return;
        }
        if (session.kind !== "native") return giveUp("its first turn didn't start here");
        // The carried session didn't open. The same continue message, held unsent by the failed
        // open, goes again with the handoff in front of it: still one message.
        ports.atomic(() => {
          ports.dropSession(start.threadId);
          ports.adoptHandoff(start.threadId, input.handoff, input.from);
          ports.starts.summary(input.transferId, fallbackReason, ports.now());
        });
        session = { kind: "summary", reason: fallbackReason };
      }
    } finally {
      this.running.delete(input.transferId);
    }
  }
  /**
   * Until a run takes the continue message `key`, a failure holds it unsent, or the person acts
   * on it. One the engine can't say reached its run is read again for `uncertainMs`, then given
   * up on.
   */
  private async watch(
    threadId: string,
    key: string,
  ): Promise<"running" | "failed" | "closed" | "uncertain" | { person: string }> {
    let uncertainSince: number | undefined;
    for (;;) {
      if (this.closed) return "closed";
      if (!this.ports.threadStatus(threadId)) return "failed";
      const next = turnStart(this.ports.continueFate(threadId, key));
      if (next.kind === "person") return { person: next.reason };
      if (next.kind === "uncertain") {
        uncertainSince ??= this.ports.now();
        if (this.ports.now() - uncertainSince >= uncertainMs) return "uncertain";
      } else if (next.kind !== "wait") return next.kind;
      else uncertainSince = undefined;
      await this.ports.sleep(500);
    }
  }
}

/** The one continue message's key, and so its command id; `attempt` counts refused tries. */
const continueKey = (transferId: string, attempt: number) =>
  `transfer-live:${transferId}:continue:${attempt}`;
const fallbackReason = "the carried session didn't open here";
const fallbackKey = (input: { transferId: string }) => `transfer-live:${input.transferId}:fallback`;

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** How long a continue message may read uncertain before the start gives up on it. */
export const uncertainMs = 10 * 60_000;

/** The longest one attempt waits, and how many times a full engine may refuse it. */
const maxRetryMs = 60_000;
export const maxStartAttempts = 40;

/** Refusals that pass: the engine is full, starting or shutting down, agent control not ready. */
const transient = new Set([
  "engine_capacity_exceeded",
  "engine_starting",
  "daemon_shutting_down",
  "admission_closed",
  "Agent control is not ready",
]);

/**
 * After the engine refused the continue message: a refusal that passes is tried again, waiting
 * 1 second, doubling up to a minute, for about half an hour in all; any other ends the start at
 * once, said on the thread.
 */
export function startRetry(
  attempts: number,
  error: unknown,
): { kind: "retry"; delayMs: number } | { kind: "give_up"; reason: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (!transient.has(message))
    return { kind: "give_up", reason: `this machine refused it (${message.slice(0, 120)})` };
  if (attempts + 1 >= maxStartAttempts)
    return { kind: "give_up", reason: `this machine kept refusing it (${message.slice(0, 120)})` };
  return { kind: "retry", delayMs: Math.min(1_000 * 2 ** attempts, maxRetryMs) };
}
