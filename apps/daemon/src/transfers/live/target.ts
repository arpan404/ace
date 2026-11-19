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
import { turnStart } from "./turn-start.ts";

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
  adoptSession(
    threadId: string,
    session: { nativeSessionId: string; instanceId: string; action: "resume" | "fork" },
  ): void;
  dropSession(threadId: string): void;
  adoptHandoff(threadId: string, handoff: PortableHandoff, machine: string): void;
  send(threadId: string, key: string, text: string): void;
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
      for (;;) {
        // A retry waits out its backoff, which a restart keeps.
        const due = ports.starts.get(input.transferId)?.nextAt ?? 0;
        while (!this.closed && ports.now() < due)
          await ports.sleep(Math.min(due - ports.now(), 1_000));
        if (this.closed) return;
        if (!ports.threadStatus(start.threadId)) {
          ports.starts.started(input.transferId, false, ports.now(), "the thread was deleted here");
          return;
        }
        const path = ports.threadCwd(start.threadId) ?? input.path;
        try {
          ports.send(
            start.threadId,
            `transfer-live:${input.transferId}:continue:${session.kind}`,
            continueMessage({ from: input.from, path, live: input.live, session }),
          );
        } catch (error) {
          // Refused for now (the engine is full, starting, or out of slots): try again later.
          const next = startRetry(attempts, error);
          attempts++;
          if (next.kind === "retry") {
            ports.starts.deferred(input.transferId, ports.now() + next.delayMs, ports.now());
            continue;
          }
          ports.starts.started(input.transferId, false, ports.now(), next.reason);
          ports.notice(
            start.threadId,
            `This thread moved here from ${input.from}, but it couldn't start: ${next.reason}. Send a message to carry on.`,
          );
          return;
        }
        const outcome = await this.watch(start.threadId, session.kind === "native");
        if (outcome === "closed") return;
        if (outcome === "running" || outcome === "failed") {
          ports.starts.started(input.transferId, outcome === "running", ports.now());
          return;
        }
        // The carried session didn't open: the handoff goes in front of the next try.
        const reason = "the carried session didn't open here";
        ports.dropSession(start.threadId);
        ports.adoptHandoff(start.threadId, input.handoff, input.from);
        ports.starts.summary(input.transferId, reason, ports.now());
        session = { kind: "summary", reason };
      }
    } finally {
      this.running.delete(input.transferId);
    }
  }
  private async watch(threadId: string, native: boolean) {
    const started = this.ports.now();
    for (;;) {
      if (this.closed) return "closed";
      const status = this.ports.threadStatus(threadId);
      if (!status) return "failed";
      const next = turnStart(status, { native, waitedMs: this.ports.now() - started });
      if (next.kind === "running") return "running";
      if (next.kind === "failed") return "failed";
      if (next.kind === "retry_with_summary") return "retry";
      await this.ports.sleep(500);
    }
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The longest one attempt waits, and how many the engine may refuse before the start gives up. */
const maxRetryMs = 60_000;
export const maxStartAttempts = 40;

/**
 * After the engine refused the continue message: wait and try again, doubling up to a minute,
 * for about half an hour in all; then the start is final and the thread says why.
 */
export function startRetry(
  attempts: number,
  error: unknown,
): { kind: "retry"; delayMs: number } | { kind: "give_up"; reason: string } {
  if (attempts + 1 >= maxStartAttempts)
    return {
      kind: "give_up",
      reason: `this machine kept refusing it (${error instanceof Error ? error.message.slice(0, 120) : "refused"})`,
    };
  return { kind: "retry", delayMs: Math.min(1_000 * 2 ** attempts, maxRetryMs) };
}
