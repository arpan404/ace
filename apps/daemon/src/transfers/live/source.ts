import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CarriedSession, ProviderKind, TransferLive } from "@ace/protocol";
import { headRef } from "../landing-types.ts";
import type { OutgoingRecord, TransferPlan } from "../outgoing-rows.ts";
import type { TransferArchive, TransferGit } from "../ports.ts";
import { TransferError } from "../ports.ts";
import { sessionCarrier, SessionNotCarried } from "../sessions/index.ts";
import { stageSession } from "../sessions/stage.ts";
import { resumeMessage } from "./messages.ts";
import type { ThreadOwnership } from "./ownership.ts";
import { interrupts, safePoint, type TurnFacts } from "./safe-point.ts";

/** What the source machine does to a thread it moves (ADR 0191), narrowed for tests. */
export interface LiveSourcePorts {
  ownership: ThreadOwnership;
  git: Pick<TransferGit, "bundleRefs" | "captureChanges" | "createBundle" | "pinRef">;
  archive: Pick<TransferArchive, "packFolder">;
  /** The thread's provider and the session its agent runs in. */
  session(
    threadId: string,
  ): { provider: ProviderKind; cwd: string; nativeSessionId?: string; home?: string } | undefined;
  turnFacts(threadId: string): TurnFacts;
  /** The root agent's own interrupt (`thread.interrupt`), keyed so a repeat runs once. */
  interrupt(threadId: string, key: string): void;
  /** Ends the provider's process: its background shells and the session's writer stop. */
  stopProvider(threadId: string): Promise<void>;
  shells(threadId: string): string[];
  /** Open terminals by name, then stops them. */
  terminals(threadId: string): string[];
  stopTerminals(threadId: string): Promise<void>;
  localChildren(threadId: string): { threadId: string; title: string }[];
  stopChild(threadId: string, key: string): void;
  remoteChildren(threadId: string): string[];
  queued(threadId: string): number;
  /** The "Moving to <machine>" background row that keeps the thread from reading done. */
  hold(threadId: string, transferId: string, change: { title: string } | { ended: true }): void;
  /** The thread reads moved and records where (one transaction with the ownership change). */
  moved(threadId: string, to: { hostId: string; name: string; threadId: string }): void;
  /** The fence lifted: work held while it stood (queued messages, controls) dispatches. */
  released(threadId: string): void;
  /** Sends the agent a message, keyed so a repeat sends once. */
  send(threadId: string, key: string, text: string): void;
  atomic<T>(run: () => T): T;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** Kept on the transfer row once the stop is done, so a restart sends the same final payload. */
export interface LivePlan {
  final: { path: string; bytes: number; sha256: string };
  carried: TransferLive;
  branch?: string | undefined;
  head?: string | undefined;
  changes?: { ref: string; commit: string } | undefined;
}

/** Where the changes made after the bulk are captured, and where the bulk's head is pinned. */
export const finalChangesRef = (transferId: string) => `refs/ace/transfer-final/${transferId}`;
export const bulkHeadRef = (transferId: string) => `refs/ace/transfer-bulk/${transferId}`;

/** How long an interrupt may take to end the turn before the move carries on regardless. */
const interruptMs = 30_000;
/** How long one provider process may take to exit once asked to close. */
const closeMs = 10_000;

export class LiveSource {
  private ports: LiveSourcePorts;
  constructor(ports: LiveSourcePorts) {
    this.ports = ports;
  }
  /**
   * Refuses new turns, waits for a safe point, interrupts, stops what can't move, then writes
   * the final payload: what changed since the bulk and the provider's session. `interrupted`
   * is told durably the moment the turn is interrupted. Safe to run again after a restart.
   */
  async stop(input: {
    record: OutgoingRecord;
    plan: TransferPlan;
    directory: string;
    signal: AbortSignal;
    interrupted(): void;
  }): Promise<LivePlan> {
    const { ports } = this;
    const { record, plan, signal } = input;
    const { transferId, target } = record.transfer;
    const threadId = need(record.transfer.threadId);
    ports.ownership.change(threadId, {
      to: "stopping",
      transferId,
      peer: { hostId: target.hostId, name: target.name },
      at: ports.now(),
    });
    if (!record.request.agent)
      ports.hold(threadId, transferId, { title: `Moving to ${target.name}` });
    await this.safePoint(threadId, transferId, signal, input.interrupted);
    const left = {
      shells: [...ports.shells(threadId), ...ports.terminals(threadId)].slice(0, 32),
      children: ports
        .localChildren(threadId)
        .map((child) => child.title.slice(0, 256))
        .slice(0, 32),
      remoteChildren: ports.remoteChildren(threadId).slice(0, 32),
      queued: ports.queued(threadId),
    };
    await ports.stopTerminals(threadId);
    await this.stopChildren(threadId, transferId, signal);
    // The provider's process goes, so its background shells stop and its session file is whole.
    await this.closeWithin(threadId, ports.now() + closeMs, signal, "The agent");
    const folder = join(input.directory, `${transferId}.final.d`);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      const git =
        record.transfer.method === "archive" ? undefined : await this.delta(record, plan, folder);
      const session = await this.session(threadId, join(folder, "session"));
      const file = join(input.directory, `${transferId}.final.tar`);
      const packed = await ports.archive.packFolder(folder, file, { signal });
      const owner = ports.ownership.get(threadId);
      return {
        final: { path: file, bytes: packed.bytes, sha256: packed.sha256 },
        carried: {
          epoch: owner?.epoch ?? 1,
          sourceThreadId: threadId as TransferLive["sourceThreadId"],
          left,
          ...(git
            ? {
                bulk: {
                  ...(plan.branch ? { branch: plan.branch } : {}),
                  ...(plan.head ? { head: plan.head } : {}),
                  ...(plan.changes ? { changes: plan.changes } : {}),
                },
              }
            : {}),
          ...session,
        },
        ...git,
      };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  /**
   * Stops every subagent thread running here and waits until each has really stopped: its turn
   * ended (up to 30 s from the interrupt, shared by all of them), then its provider process
   * closed and exited (up to 10 s each). A child whose process is still running then fails the
   * move before the hand-over, so no snapshot is taken while it writes, and no close that never
   * returns can hang it.
   */
  private async stopChildren(threadId: string, transferId: string, signal: AbortSignal) {
    const { ports } = this;
    const children = ports.localChildren(threadId);
    for (const child of children)
      ports.stopChild(child.threadId, `transfer-live:${transferId}:stop:${child.threadId}`);
    const until = ports.now() + interruptMs;
    for (const child of children) {
      while (ports.turnFacts(child.threadId).turnRunning && ports.now() < until) {
        signal.throwIfAborted();
        await ports.sleep(250, signal);
      }
      await this.closeWithin(
        child.threadId,
        ports.now() + closeMs,
        signal,
        `The subagent "${child.title}"`,
      );
    }
  }
  /** Ends a thread's provider process and waits for it to exit, by `until` at the latest. */
  private async closeWithin(threadId: string, until: number, signal: AbortSignal, who: string) {
    const { ports } = this;
    const closed = ports.stopProvider(threadId).then(
      () => "exited" as const,
      () => "failed" as const,
    );
    const waited = new AbortController();
    const onAbort = () => waited.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const outcome = await Promise.race([
        closed,
        ports
          .sleep(Math.max(0, until - ports.now()), waited.signal)
          .then(() => "timed_out" as const),
      ]);
      signal.throwIfAborted();
      if (outcome !== "exited")
        throw new TransferError(
          "process_still_running",
          `${who} on this machine didn't stop, so the work stayed here.`,
        );
    } finally {
      waited.abort();
      signal.removeEventListener("abort", onAbort);
    }
  }
  private async safePoint(
    threadId: string,
    transferId: string,
    signal: AbortSignal,
    noted: () => void,
  ): Promise<void> {
    const { ports } = this;
    const started = ports.now();
    for (;;) {
      signal.throwIfAborted();
      const point = safePoint(ports.turnFacts(threadId), ports.now() - started);
      if (point.kind === "wait") {
        await ports.sleep(500, signal);
        continue;
      }
      if (!interrupts(point)) return;
      noted();
      ports.interrupt(threadId, `transfer-live:${transferId}:interrupt`);
      break;
    }
    const since = ports.now();
    while (ports.turnFacts(threadId).turnRunning && ports.now() - since < interruptMs) {
      signal.throwIfAborted();
      await ports.sleep(250, signal);
    }
  }
  /**
   * The checkout as it is now, as a capture commit, and a bundle of only what the bulk lacks:
   * the branch and that commit, excluding the bulk's head and capture commit.
   */
  private async delta(record: OutgoingRecord, plan: TransferPlan, folder: string) {
    const { git } = this.ports;
    const { transferId } = record.transfer;
    const refs = await git.bundleRefs(plan.source);
    const changes = record.request.includeChanges
      ? await git.captureChanges(plan.source, {
          ref: finalChangesRef(transferId),
          message: "Uncommitted changes carried to another machine",
        })
      : undefined;
    if (!refs.branch && refs.head) await git.pinRef(plan.source, headRef(transferId), refs.head);
    if (plan.head) await git.pinRef(plan.source, bulkHeadRef(transferId), plan.head);
    const wanted = [
      ...(refs.branch ? [`refs/heads/${refs.branch}`] : refs.head ? [headRef(transferId)] : []),
      ...(changes ? [finalChangesRef(transferId)] : []),
    ];
    const exclude = [
      ...(plan.head ? [bulkHeadRef(transferId)] : []),
      ...(plan.changes ? [plan.changes.ref] : []),
    ];
    if (wanted.length)
      await git.createBundle(plan.source, {
        file: join(folder, "delta.bundle"),
        refs: wanted,
        ...(exclude.length ? { exclude } : {}),
      });
    return {
      ...(refs.branch ? { branch: refs.branch } : {}),
      ...(refs.head ? { head: refs.head } : {}),
      ...(changes ? { changes: { ref: finalChangesRef(transferId), commit: changes.commit } } : {}),
    };
  }
  /** The provider's own session into `folder`, or why it stays behind. */
  private async session(
    threadId: string,
    folder: string,
  ): Promise<{ session: CarriedSession } | { unsupported: string }> {
    const found = this.ports.session(threadId);
    if (!found) return { unsupported: "the agent had no session to carry" };
    const carrier = sessionCarrier(found.provider);
    if (!carrier) return { unsupported: `${found.provider} sessions aren't carried yet` };
    if (!found.nativeSessionId) return { unsupported: "the agent had no session to carry" };
    if (!found.home) return { unsupported: "the account's folder isn't on this machine" };
    try {
      const captured = await carrier.capture({
        home: found.home,
        nativeSessionId: found.nativeSessionId,
      });
      const files = await stageSession(captured, folder);
      return {
        session: {
          provider: found.provider,
          nativeSessionId: found.nativeSessionId,
          sourceCwd: found.cwd,
          files,
        },
      };
    } catch (error) {
      if (!(error instanceof SessionNotCarried)) throw error;
      return { unsupported: error.message.slice(0, 256) };
    }
  }
  /** Where this transfer's handover stands in the thread's ownership record, if it holds it. */
  owner(record: OutgoingRecord): "stopping" | "handing" | "moved" | undefined {
    const threadId = record.transfer.threadId;
    const found = threadId ? this.ports.ownership.get(threadId) : undefined;
    if (!found || found.transferId !== record.transfer.transferId || found.state === "owned")
      return undefined;
    return found.state;
  }
  /** The commit may reach the target from now on; recorded before it leaves. */
  handing(record: OutgoingRecord): void {
    this.ports.ownership.change(need(record.transfer.threadId), {
      to: "handing",
      transferId: record.transfer.transferId,
      at: this.ports.now(),
    });
  }
  /** The target owns the thread: it reads moved here, in one transaction. */
  moved(record: OutgoingRecord, peerThread: string): void {
    const threadId = need(record.transfer.threadId);
    const { transferId, target } = record.transfer;
    this.ports.atomic(() => {
      this.ports.ownership.change(threadId, {
        to: "moved",
        transferId,
        peerThread,
        at: this.ports.now(),
      });
      this.ports.moved(threadId, {
        hostId: target.hostId,
        name: target.name,
        threadId: peerThread,
      });
    });
    if (!record.request.agent) this.ports.hold(threadId, transferId, { ended: true });
  }
  /**
   * The thread is this machine's again: the fence and the hold go, and an agent that was stopped
   * is told to carry on. `confirmed`: the target said it never took the thread.
   */
  release(
    record: OutgoingRecord,
    input: { confirmed: boolean; interrupted: boolean; reason: string },
  ): void {
    const threadId = need(record.transfer.threadId);
    const { transferId, target } = record.transfer;
    const owner = this.ports.ownership.get(threadId);
    if (owner?.transferId === transferId && owner.state !== "moved" && owner.state !== "owned")
      this.ports.ownership.change(threadId, {
        to: "local",
        transferId,
        confirmed: input.confirmed,
        at: this.ports.now(),
      });
    if (!record.request.agent) this.ports.hold(threadId, transferId, { ended: true });
    this.ports.released(threadId);
    if (input.interrupted)
      this.ports.send(
        threadId,
        `transfer-live:${transferId}:resume`,
        resumeMessage(target.name, input.reason),
      );
  }
}

function need(threadId: string | undefined): string {
  if (!threadId) throw new TransferError("invalid", "A live move needs its thread.");
  return threadId;
}
