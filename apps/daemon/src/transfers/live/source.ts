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

/** What the source machine does to a thread it moves (ADR 0191), narrowed for tests. */
export interface LiveSourcePorts {
  ownership: ThreadOwnership;
  git: Pick<TransferGit, "bundleRefs" | "captureChanges" | "createBundle" | "pinRef">;
  archive: Pick<TransferArchive, "packFolder">;
  /** The thread's provider and the session its agent runs in. */
  session(
    threadId: string,
  ): { provider: ProviderKind; cwd: string; nativeSessionId?: string; home?: string } | undefined;
  /**
   * ace's own Stop of the thread with every agent under it: the same command the person's Stop
   * sends (`thread.interrupt` with cascade), keyed so a repeat runs once.
   */
  stop(threadId: string, key: string): void;
  /**
   * The thread and its whole tree read at rest by the normal status rules, the move's own hold
   * (`task`) aside: nothing working, waiting on the person, or running in the background.
   */
  atRest(threadId: string, task: string): boolean;
  /**
   * The provider's background shells and monitors still running anywhere in the thread's tree,
   * by title: the work the whole-thread Stop stops. A finished turn's build reads done by design
   * (ADR 0116), so being at rest alone never shows it ended.
   */
  shells(threadId: string): string[];
  /**
   * Threads of the tree whose Stop is still in flight, by title: its interrupt, shell stops or
   * close haven't finished, so a status at rest doesn't yet say the work ended.
   */
  stopping(threadId: string): string[];
  /**
   * Threads of the tree whose provider never confirmed its close, by title: a Stop that gave up
   * waiting reads them stopped, but the process and its shells may still run.
   */
  unconfirmedExits(threadId: string): string[];
  /**
   * Refuses new terminals in the thread's tree until the returned release: from the start of
   * the stop, before the ownership record holds the thread.
   */
  holdTerminals(threadId: string): () => void;
  /** Open terminals in the thread's tree, by name. */
  terminals(threadId: string): string[];
  /** Ends the processes in the tree's terminals, as settling a thread does. */
  stopTerminals(threadId: string): Promise<void>;
  /** Subagent threads of the tree here, at any depth, still live: the ones a Stop stops. */
  children(threadId: string): string[];
  /**
   * The tree's children on other machines, by role: those still running, and those settled
   * without their machine confirming they stopped (every cancel went unanswered, it can never
   * answer, or lost), whenever that was: an earlier attempt's stays until its machine answers.
   * Ordinary status reads the latter as stopped (ADR 0052); a move doesn't.
   */
  remoteChildren(threadId: string): {
    running: string[];
    unconfirmed: string[];
    /** False while the older rows of some parent are still being looked through. */
    complete?: boolean;
  };
  queued(threadId: string): number;
  /** The "Moving to <machine>" background row that keeps the thread from reading done. */
  hold(threadId: string, transferId: string, change: { title: string } | { ended: true }): void;
  /** The thread reads moved and records where (one transaction with the ownership change). */
  moved(threadId: string, to: { hostId: string; name: string; threadId: string }): void;
  /** The hold lifted: work it held dispatches. */
  released(threadId: string): void;
  /** Owes the agent a message, sent durably until the engine takes it. */
  resume(threadId: string, transferId: string, text: string): void;
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

/** How long the stopped tree may take to read at rest before the move gives up. */
const restMs = 60_000;

/** The move's own background row, which is all that may still run once the tree stopped. */
export const holdTask = (transferId: string) => `ace-transfer:${transferId}`;

export class LiveSource {
  private ports: LiveSourcePorts;
  constructor(ports: LiveSourcePorts) {
    this.ports = ports;
  }
  /**
   * Stops the thread's tree with ace's own Stop, waits until it reads at rest, then holds new
   * input for the hand-over and writes the final payload: what changed since the bulk and the
   * provider's session. `interrupted` is told durably when the Stop is sent. Safe to run again
   * after a restart.
   */
  async stop(input: {
    record: OutgoingRecord;
    plan: TransferPlan;
    directory: string;
    signal: AbortSignal;
    interrupted(): void;
  }): Promise<LivePlan> {
    const { ports } = this;
    const { record } = input;
    const { transferId, target } = record.transfer;
    const threadId = need(record.transfer.threadId);
    if (!record.request.agent)
      ports.hold(threadId, transferId, { title: `Moving to ${target.name}` });
    // No terminal opens in the tree from here: one opened while the move waits would keep
    // writing after the hand-over. Lifted when this returns, once the ownership record holds the
    // thread, or when it fails.
    const releaseTerminals = ports.holdTerminals(threadId);
    try {
      // What the Stop stops, said in the continue message so the agent there can start it again.
      const left = {
        shells: [...ports.shells(threadId), ...ports.terminals(threadId)].slice(0, 32),
        children: ports
          .children(threadId)
          .map((title) => title.slice(0, 256))
          .slice(0, 32),
        remoteChildren: ports.remoteChildren(threadId).running.slice(0, 32),
        queued: ports.queued(threadId),
      };
      return await this.stopHeld(input, threadId, left);
    } finally {
      releaseTerminals();
    }
  }
  private async stopHeld(
    input: {
      record: OutgoingRecord;
      plan: TransferPlan;
      directory: string;
      signal: AbortSignal;
      interrupted(): void;
    },
    threadId: string,
    left: TransferLive["left"],
  ): Promise<LivePlan> {
    const { ports } = this;
    const { record, plan, signal } = input;
    const { transferId, target } = record.transfer;
    // Always the whole Stop, even for a thread at rest: a shell its last turn left running
    // stops too. Only a thread that was working is owed the message to carry on.
    if (!ports.atRest(threadId, holdTask(transferId))) input.interrupted();
    ports.stop(threadId, `transfer-live:${transferId}:stop`);
    await ports.stopTerminals(threadId);
    const until = ports.now() + restMs;
    for (;;) {
      signal.throwIfAborted();
      // Only a stop its machine confirmed counts: a child that may still be writing stays here.
      const remote = ports.remoteChildren(threadId);
      if (remote.unconfirmed.length)
        throw new TransferError(
          "remote_child_unconfirmed",
          `${remote.unconfirmed[0]} on another machine never confirmed it stopped, so the thread stayed here.`.slice(
            0,
            512,
          ),
        );
      // Only a close its provider confirmed counts: a process that may still run stays here.
      const exits = ports.unconfirmedExits(threadId);
      if (exits.length)
        throw new TransferError(
          "process_unconfirmed",
          `${exits[0]} didn't confirm it stopped, so the thread stayed here.`.slice(0, 512),
        );
      // Read in the same step as the hold below: a terminal still open here (one an earlier
      // run of this stop, before a restart, didn't hold) is stopped and looked at again.
      const shells = [...ports.shells(threadId), ...ports.terminals(threadId)];
      // Stop's own escalation finishes first: a provider that ended its turn but never answered
      // its interrupt reads at rest while Stop still waits to close it, unconfirmed or not.
      const stopping = ports.stopping(threadId);
      // A read still looking through older rows can't yet say the tree is clear: wait for it.
      const checking = remote.complete === false;
      if (
        ports.atRest(threadId, holdTask(transferId)) &&
        !shells.length &&
        !remote.running.length &&
        !stopping.length &&
        !checking
      )
        break;
      if (ports.terminals(threadId).length) await ports.stopTerminals(threadId);
      if (ports.now() >= until)
        throw shells.length
          ? new TransferError(
              "process_still_running",
              `${shells[0]} didn't stop, so the thread stayed here.`.slice(0, 512),
            )
          : checking
            ? new TransferError(
                "remote_children_unread",
                "The subagents on other machines couldn't all be checked in time, so the thread stayed here.",
              )
            : new TransferError(
                "tree_still_working",
                "The work here didn't stop, so it stayed here.",
              );
      await ports.sleep(250, signal);
    }
    // At rest, with no process or terminal left running: from here new input waits for the
    // hand-over. Written in the same step that saw the tree at rest, so nothing started between.
    ports.ownership.change(threadId, {
      to: "stopping",
      transferId,
      peer: { hostId: target.hostId, name: target.name },
      at: ports.now(),
    });
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
  /**
   * The "Moving to" row says plainly when the machine isn't linked now, and says it no more once
   * a link to it is back.
   */
  waiting(record: OutgoingRecord, unlinked: boolean): void {
    const threadId = record.transfer.threadId;
    if (!threadId || record.request.agent) return;
    const name = record.transfer.target.name;
    this.ports.hold(threadId, record.transfer.transferId, {
      title: unlinked ? `Moving to ${name}, which isn't linked any more` : `Moving to ${name}`,
    });
  }
  /**
   * The person chose to carry on here while the machine can't be asked, warned that both may
   * run if it already took the thread. Recorded on the transfer by the caller; here, in one
   * transaction, the thread is this machine's again and a stopped agent is told to carry on.
   */
  carryOnHere(record: OutgoingRecord): void {
    const threadId = need(record.transfer.threadId);
    const { transferId, target } = record.transfer;
    this.ports.atomic(() => {
      const owner = this.ports.ownership.get(threadId);
      if (owner?.transferId === transferId && owner.state !== "moved" && owner.state !== "owned")
        this.ports.ownership.change(threadId, {
          to: "local",
          transferId,
          confirmed: false,
          byPerson: true,
          at: this.ports.now(),
        });
      if (!record.request.agent) this.ports.hold(threadId, transferId, { ended: true });
      if (record.plan?.interrupted)
        this.ports.resume(
          threadId,
          transferId,
          resumeMessage(
            target.name,
            `the person chose to carry on here while ${target.name} wasn't linked.`,
          ),
        );
    });
    this.ports.released(threadId);
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
   * The thread is this machine's again, in one transaction: the hold on new input goes, the
   * "Moving to" row ends, and a stopped agent is owed the message that tells it to carry on.
   * `confirmed`: the target said it never took the thread.
   */
  release(
    record: OutgoingRecord,
    input: { confirmed: boolean; interrupted: boolean; reason: string },
  ): void {
    const threadId = need(record.transfer.threadId);
    const { transferId, target } = record.transfer;
    this.ports.atomic(() => {
      const owner = this.ports.ownership.get(threadId);
      if (owner?.transferId === transferId && owner.state !== "moved" && owner.state !== "owned")
        this.ports.ownership.change(threadId, {
          to: "local",
          transferId,
          confirmed: input.confirmed,
          at: this.ports.now(),
        });
      if (!record.request.agent) this.ports.hold(threadId, transferId, { ended: true });
      if (input.interrupted)
        this.ports.resume(threadId, transferId, resumeMessage(target.name, input.reason));
    });
    this.ports.released(threadId);
  }
}

function need(threadId: string | undefined): string {
  if (!threadId) throw new TransferError("invalid", "A live move needs its thread.");
  return threadId;
}
