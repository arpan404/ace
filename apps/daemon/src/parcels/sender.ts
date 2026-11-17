import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  ParcelAnswer,
  ParcelId,
  ParcelName,
  ThreadId,
  maxParcelBytes,
  type AgentControlOperation,
  type MachineCallOrigin,
  type ParcelCall,
} from "@ace/protocol";
import { AgentControlError } from "../agent-control/failure.ts";
import type { RemoteProfile } from "../cli/profiles.ts";
import { MachineFailure } from "../machines/transport.ts";
import { ParcelFileError, type ParcelFiles } from "./files.ts";
import type { ParcelLink } from "./link.ts";
import { resultText } from "./messages.ts";
import { PARCEL_DEADLINE_MS, mayDeliverLocally, nextRange, retryDelay } from "./rules.ts";
import type { TreeThread } from "./rules.ts";
import type { InRow, OutRow, ParcelRows } from "./store.ts";

type SendOperation = Extract<AgentControlOperation, { op: "data.send" }>;

/** A local thread as the sender needs it. */
export interface SenderThread extends TreeThread {
  title: string;
  readOnly: boolean;
  /** Its working folder, where `path` is read from. */
  folder?: string | undefined;
}

export interface ParcelSenderDeps {
  rows: ParcelRows;
  files: ParcelFiles;
  link: ParcelLink;
  profiles(): RemoteProfile[];
  thread(id: string): SenderThread | undefined;
  /** A child this machine delegated to another machine: its parent here and its machine. */
  remoteChild(id: string): { parentThread: string; machine: string } | undefined;
  /** The thread here an agent on another machine delegated: that device, machine and thread. */
  remoteParent(
    id: string,
  ): { deviceId: string; originHost: string; originThread: string; machine: string } | undefined;
  origin(threadId: string, agentId: string): Promise<MachineCallOrigin>;
  /** The background row that keeps the sender's tree working until the parcel settles. */
  hold(
    threadId: string,
    agentId: string,
    key: string,
    change: { title: string } | { status: "completed" | "failed" | "stopped" },
  ): void;
  /** Hands text to a thread as a new turn, once per key; throws while it can't yet. */
  deliver(threadId: string, key: string, text: string): void;
  /** A local parcel landed: the receiving thread is told. */
  arrived(row: InRow): void;
  /** Bytes still free under the parcel quota. */
  room(): number;
  /**
   * A child on another machine that is about to get data: open again in the parent's tree, as
   * a message to it does, since the parcel's notice starts a new turn there.
   */
  reopenChild(id: string): void;
  now(): number;
  /** Runs `run` after `ms`; returns its cancel. */
  schedule(ms: number, run: () => void): () => void;
  log(message: string, fields: Record<string, unknown>): void;
}

/** Who receives a parcel and how it travels there. */
type Plan =
  | {
      route: "local";
      to: string;
      machine?: undefined;
      hostId?: undefined;
      deviceId?: undefined;
      originHost?: undefined;
    }
  | {
      route: "push";
      to: string;
      machine: string;
      hostId: string;
      deviceId?: undefined;
      originHost?: undefined;
    }
  | {
      route: "outbox";
      to: string;
      machine: string;
      deviceId: string;
      originHost: string;
      hostId?: undefined;
    };

const CALL_MS = 30_000;
const PARALLEL = 4;
const MAX_RESTARTS = 3;
/** A result tried this many times without reaching its thread ends its hold anyway. */
const MAX_REPORT_TRIES = 20;

function refuse(code: "invalid_arguments" | "not_found" | "machine_forbidden", detail: string) {
  return new AgentControlError(code, code, undefined, detail);
}

/**
 * Outgoing parcels (ADR 0182). The sending machine owns each one from the moment it is staged:
 * it keeps the snapshot and the row, resumes from what the receiver holds after any lost call or
 * restart, and settles it exactly once, telling the sending thread and ending its hold.
 */
export class ParcelSender {
  private deps: ParcelSenderDeps;
  private running = new Map<string, AbortController>();
  /** Parcels being cancelled: no push starts for them meanwhile. */
  private cancelling = new Set<string>();
  /** Results that couldn't be handed over yet, by parcel: how often it was tried. */
  private reportTries = new Map<string, number>();
  /** The next wake for parcels waiting out a retry, if one is set. */
  private wake: { at: number; stop: () => void } | undefined;
  private closed = new AbortController();
  constructor(deps: ParcelSenderDeps) {
    this.deps = deps;
  }
  async send(caller: { threadId: string; agentId: string }, operation: SendOperation) {
    const { deps } = this;
    const sender = deps.thread(caller.threadId);
    if (!sender) throw new AgentControlError("thread_not_found", "caller_missing");
    if (sender.readOnly)
      throw refuse("machine_forbidden", "This thread is read-only, so it can't send data.");
    if ((operation.path === undefined) === (operation.text === undefined))
      throw refuse("invalid_arguments", "Pass path or text, not both.");
    const name = ParcelName.safeParse(
      operation.name ?? (operation.path ? basename(operation.path) : "message.txt"),
    );
    if (!name.success) throw refuse("invalid_arguments", "name must be a plain file name.");
    // Who receives, and how it travels there.
    const plan = this.route(caller.threadId, operation.to);
    const parcelId = `pcl-${randomUUID()}`;
    let staged: { size: number; sha256: string };
    try {
      if (operation.path !== undefined && !sender.folder)
        throw new ParcelFileError("not_found", "This thread has no project folder to read from.");
      staged = await deps.files.stage(
        parcelId,
        operation.text !== undefined
          ? { text: operation.text }
          : { project: sender.folder ?? "", path: operation.path ?? "" },
      );
    } catch (error) {
      if (error instanceof ParcelFileError)
        throw refuse(error.code === "not_found" ? "not_found" : "invalid_arguments", error.message);
      throw error;
    }
    if (staged.size > deps.room() || staged.size > maxParcelBytes) {
      await deps.files.removeOut(parcelId);
      throw refuse("invalid_arguments", "There's no room for that parcel here now.");
    }
    const now = deps.now();
    const row: OutRow = {
      parcelId,
      fromThread: caller.threadId,
      fromAgent: caller.agentId,
      toThread: plan.to,
      route: plan.route,
      machine: plan.machine,
      hostId: plan.hostId,
      deviceId: plan.deviceId,
      originHost: plan.originHost,
      facts: {
        parcelId: ParcelId.parse(parcelId),
        name: name.data,
        size: staged.size,
        sha256: staged.sha256,
        ...(operation.note ? { note: operation.note } : {}),
        fromTitle: sender.title.slice(0, 256),
      },
      state: plan.route === "outbox" ? "waiting" : "sending",
      held: 0,
      attempts: 0,
      nextAt: now,
      createdAt: now,
      updatedAt: now,
      delivered: false,
    };
    deps.rows.insertOut(row);
    deps.hold(caller.threadId, caller.agentId, `ace-parcel:${parcelId}`, {
      title: `Sending ${name.data} to ${plan.route === "local" ? "a thread here" : plan.route === "outbox" ? "its parent" : plan.machine}`,
    });
    if (plan.route === "local") await this.local(row);
    else if (plan.route === "push") {
      deps.reopenChild(plan.to);
      this.kick();
    }
    return {
      parcelId,
      to: plan.to,
      ...(plan.machine ? { machine: plan.machine } : {}),
      size: staged.size,
      sha256: staged.sha256,
      next: "Whether it arrived comes as a new turn. Don't poll.",
    };
  }
  private route(from: string, to: string | "parent"): Plan {
    const { deps } = this;
    const sender = deps.thread(from);
    if (to === "parent") {
      if (sender?.delegatedBy) return this.route(from, sender.delegatedBy);
      const remote = deps.remoteParent(from);
      if (!remote) throw refuse("not_found", "This thread has no parent agent.");
      return {
        route: "outbox" as const,
        to: remote.originThread,
        machine: remote.machine,
        deviceId: remote.deviceId,
        originHost: remote.originHost,
      };
    }
    if (deps.thread(to)) {
      if (!mayDeliverLocally(from, to, (id) => deps.thread(id)))
        throw refuse("machine_forbidden", "Data goes only to threads in your own agent tree.");
      return { route: "local" as const, to };
    }
    const child = deps.remoteChild(to);
    if (child) {
      if (child.parentThread !== from && !mayDeliverLocally(from, child.parentThread, deps.thread))
        throw refuse("machine_forbidden", "Data goes only to threads in your own agent tree.");
      const profile = deps.profiles().find((entry) => entry.name === child.machine);
      if (!profile) throw refuse("not_found", `${child.machine} is no longer linked.`);
      return {
        route: "push" as const,
        to,
        machine: child.machine,
        hostId: profile.hostId ?? profile.id,
      };
    }
    throw refuse("not_found", "No such thread in your tree, here or on a linked machine.");
  }
  /** Another thread here: the snapshot is copied in and checked like any arrival. */
  private async local(row: OutRow) {
    const { deps } = this;
    const now = deps.now();
    const incoming: InRow = {
      parcelId: row.parcelId,
      toThread: row.toThread,
      fromThread: row.fromThread,
      source: "local",
      facts: row.facts,
      state: "receiving",
      held: 0,
      createdAt: now,
      updatedAt: now,
      notified: false,
    };
    deps.rows.insertIn(incoming);
    try {
      for (let held = 0; ;) {
        const range = nextRange(held, row.facts.size);
        if (!range) break;
        const bytes = await deps.files.readOut(row.parcelId, range.offset, range.length);
        await deps.files.append(row.parcelId, range.offset, bytes);
        held += bytes.length;
      }
      await deps.files.finish(row.parcelId, row.facts.name, row.facts.size, row.facts.sha256);
    } catch (error) {
      await deps.files.removeIn(row.parcelId);
      deps.rows.updateIn(row.parcelId, { state: "cancelled" }, deps.now());
      this.settle(row.parcelId, "failed", `It couldn't be copied: ${String(error).slice(0, 200)}`);
      return;
    }
    deps.rows.updateIn(row.parcelId, { state: "delivered", held: row.facts.size }, deps.now());
    const landed = deps.rows.in(row.parcelId);
    if (landed) deps.arrived(landed);
    this.settle(row.parcelId, "delivered");
  }
  /**
   * Starts pushes that are due, at most a few at once. One waiting out a retry holds no slot:
   * a wake is set for the earliest of them instead.
   */
  kick(dueBy?: number): void {
    if (this.closed.signal.aborted) return;
    const now = this.deps.now();
    // A wake set for `dueBy` makes due what it was set for, whatever the clock reads by then.
    for (const row of this.deps.rows.duePushes(Math.max(now, dueBy ?? now))) {
      if (this.running.size >= PARALLEL) return;
      if (this.running.has(row.parcelId) || this.cancelling.has(row.parcelId)) continue;
      const stop = new AbortController();
      this.running.set(row.parcelId, stop);
      void this.push(row.parcelId, AbortSignal.any([stop.signal, this.closed.signal]))
        .catch((error: unknown) =>
          this.deps.log("Parcel stopped", { parcelId: row.parcelId, error: String(error) }),
        )
        .finally(() => {
          this.running.delete(row.parcelId);
          this.kick();
        });
    }
    const next = this.deps.rows.nextPushAt(now);
    if (next === undefined || (this.wake && this.wake.at <= next)) return;
    this.wake?.stop();
    const at = next;
    this.wake = {
      at,
      stop: this.deps.schedule(Math.max(0, at - now), () => {
        if (this.wake?.at === at) this.wake = undefined;
        this.kick(at);
      }),
    };
  }
  /** Copies to threads here that a restart cut off: done again, or settled when they landed. */
  async recoverLocal(): Promise<void> {
    for (const row of this.deps.rows.unsettledLocal()) {
      const landed = this.deps.rows.in(row.parcelId);
      if (landed?.state === "delivered") {
        this.settle(row.parcelId, "delivered");
        continue;
      }
      if (landed) {
        await this.deps.files.removeIn(row.parcelId);
        this.deps.rows.removeIn(row.parcelId);
      }
      await this.local(row);
    }
  }
  private async call(row: OutRow, profile: RemoteProfile, parcel: ParcelCall, signal: AbortSignal) {
    const origin = await this.deps.origin(row.fromThread, row.fromAgent);
    const { answer } = await this.deps.link.call(
      profile,
      { origin, call: { op: "parcel", parcel } },
      { timeoutMs: CALL_MS, signal },
    );
    const parsed = ParcelAnswer.safeParse(answer);
    if (!parsed.success) throw new MachineFailure("refused", "invalid", "Unreadable answer");
    return parsed.data;
  }
  private async push(parcelId: string, signal: AbortSignal): Promise<void> {
    const { deps } = this;
    let restarts = 0;
    for (;;) {
      const row = deps.rows.out(parcelId);
      if (!row || (row.state !== "sending" && row.state !== "waiting")) return;
      if (signal.aborted) return;
      const profile = deps
        .profiles()
        .find((entry) => entry.name === row.machine && (entry.hostId ?? entry.id) === row.hostId);
      if (!profile) {
        this.settle(parcelId, "failed", `${row.machine} is no longer linked to this machine.`);
        return;
      }
      if (deps.now() - row.createdAt > PARCEL_DEADLINE_MS) {
        this.settle(parcelId, "failed", `${row.machine} couldn't be reached for a day.`);
        return;
      }
      try {
        let answer = await this.call(
          row,
          profile,
          { action: "offer", to: ThreadId.parse(row.toThread), parcel: row.facts },
          signal,
        );
        while ("state" in answer && answer.state === "receiving") {
          // It answered: the next failure waits from the start again.
          deps.rows.updateOut(parcelId, { held: answer.offset, attempts: 0 }, deps.now());
          const range = nextRange(answer.offset, row.facts.size);
          if (!range) {
            answer = await this.call(
              row,
              profile,
              { action: "commit", parcelId: row.facts.parcelId },
              signal,
            );
            // A digest mismatch there drops what it held: start over, a few times at most.
            if ("state" in answer && answer.state === "receiving" && answer.offset === 0) {
              if (++restarts > MAX_RESTARTS) {
                this.settle(parcelId, "failed", "Its bytes kept arriving damaged.");
                return;
              }
            }
            continue;
          }
          const bytes = await deps.files.readOut(parcelId, range.offset, range.length);
          answer = await this.call(
            row,
            profile,
            {
              action: "chunk",
              parcelId: row.facts.parcelId,
              offset: range.offset,
              data: bytes.toString("base64"),
            },
            signal,
          );
        }
        if ("state" in answer && answer.state === "delivered") this.settle(parcelId, "delivered");
        else if ("state" in answer && answer.state === "cancelled")
          this.settle(parcelId, "cancelled");
        else this.settle(parcelId, "failed", "The other machine gave an unexpected answer.");
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof MachineFailure && error.kind === "refused") {
          this.settle(parcelId, "failed", error.message.slice(0, 300));
          return;
        }
        // Tried again once its wait is over, without holding a slot meanwhile.
        const attempts = (deps.rows.out(parcelId)?.attempts ?? row.attempts) + 1;
        deps.rows.updateOut(
          parcelId,
          { attempts, nextAt: deps.now() + retryDelay(attempts) },
          deps.now(),
        );
        return;
      }
    }
  }
  /** Stopped from its background row: the receiver drops what it holds, if it can be told. */
  async cancel(parcelId: string): Promise<void> {
    const { deps } = this;
    const row = deps.rows.out(parcelId);
    if (!row || (row.state !== "sending" && row.state !== "waiting")) return;
    this.cancelling.add(parcelId);
    try {
      await this.cancelNow(row);
    } finally {
      this.cancelling.delete(parcelId);
    }
  }
  private async cancelNow(row: OutRow): Promise<void> {
    const { deps } = this;
    const { parcelId } = row;
    this.running.get(parcelId)?.abort();
    if (row.route === "push") {
      const profile = deps
        .profiles()
        .find((entry) => entry.name === row.machine && (entry.hostId ?? entry.id) === row.hostId);
      const answer = profile
        ? await this.call(
            row,
            profile,
            { action: "cancel", parcelId: row.facts.parcelId },
            AbortSignal.timeout(10_000),
          ).catch(() => undefined)
        : undefined;
      // It landed before the cancel did: that is the truth to report.
      if (answer && "state" in answer && answer.state === "delivered") {
        this.settle(parcelId, "delivered");
        return;
      }
    }
    this.settle(parcelId, "cancelled");
  }
  /** Settles once; then the sending thread is told and its hold ends. */
  settle(parcelId: string, state: "delivered" | "failed" | "cancelled", error?: string): void {
    const { deps } = this;
    if (!deps.rows.settleOut(parcelId, state, deps.now(), error)) return;
    deps.log("Parcel settled", { parcelId, state });
    void deps.files.removeOut(parcelId).catch(() => {});
    this.report(parcelId);
  }
  /** Tells the sending thread how its parcel settled; kept for the next start if it can't yet. */
  report(parcelId: string): void {
    const { deps } = this;
    const row = deps.rows.out(parcelId);
    if (!row || row.delivered) return;
    try {
      deps.deliver(row.fromThread, `parcel-result:${row.parcelId}`, resultText(row));
    } catch {
      // Not ready yet: told on a later sweep. One that keeps failing stops holding its place.
      const tries = (this.reportTries.get(parcelId) ?? 0) + 1;
      this.reportTries.set(parcelId, tries);
      if (tries < MAX_REPORT_TRIES) return;
    }
    this.reportTries.delete(parcelId);
    try {
      deps.hold(row.fromThread, row.fromAgent, `ace-parcel:${row.parcelId}`, {
        status:
          row.state === "delivered"
            ? "completed"
            : row.state === "cancelled"
              ? "stopped"
              : "failed",
      });
    } catch {
      // The thread or its agent is gone: there is no hold left to end.
    }
    deps.rows.markOutDelivered(row.parcelId);
  }
  close(): void {
    this.closed.abort();
    this.wake?.stop();
  }
}
