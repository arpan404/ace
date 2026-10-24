import { join } from "node:path";
import {
  HostId,
  transferChunkBytes,
  type CommandId,
  type IncomingTransfer,
  type PortableHandoff,
  type ThreadContinuedOn,
  type ThreadId,
  type Transfer,
  type TransferOrigin,
  type TransferPhase,
  type TransferThread,
  type WorkspaceId,
} from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import { MachineFailure } from "../machines/transport.ts";
import type { Store } from "../store.ts";
import { TransferClient, type TransferTransport } from "./client.ts";
import { ensureDirectory, fileBytes, readAt, removeQuietly } from "./files.ts";
import { OutgoingRows, type OutgoingRecord, type TransferRequest } from "./outgoing-rows.ts";
import { planSource, writeTransferFile } from "./prepare.ts";
import { TransferError, type TransferArchive, type TransferGit } from "./ports.ts";

/** The source thread's side of a continuation. */
export interface SourceThreads {
  /** Refuses with a TransferError while the thread's tree is still working. */
  assertIdle(threadId: ThreadId): Promise<void>;
  handoff(threadId: ThreadId): PortableHandoff;
  continuedOn(threadId: ThreadId, value: ThreadContinuedOn): void;
}

export interface OutgoingDeps {
  store: Store;
  /** Where bundles and archives wait while they are sent: `<data>/transfers/outgoing`. */
  directory: string;
  git: TransferGit;
  archive: TransferArchive;
  transport: TransferTransport;
  profiles(): RemoteProfile[];
  origin(): Promise<TransferOrigin>;
  threads: SourceThreads;
  now(): number;
  /** Waits between polls and retries; resolves early when aborted. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  nextId(): string;
  log(message: string, fields: Record<string, unknown>): void;
  /** Longest a target may stay unreachable before the transfer fails. */
  offlineMs?: number;
}

export interface StartTransfer {
  commandId: CommandId;
  kind: "project" | "thread";
  workspaceId: WorkspaceId;
  threadId?: ThreadId | undefined;
  source: string;
  name: string;
  request: TransferRequest;
  target: { hostId: HostId; name: string };
}

const retentionMs = 24 * 60 * 60 * 1000;
const terminal = new Set<TransferPhase>(["completed", "failed", "cancelled"]);
const cancellable = new Set<TransferPhase>(["preparing", "cloning", "sending", "importing"]);

/**
 * The sending side of transfers (ADR 0099): one durable row per transfer, sent straight to the
 * target over its fleet link, resumed from the target's acknowledged offset after a restart or a
 * lost connection. Progress goes out on every phase change and at most every 500 ms of bytes.
 */
export class OutgoingTransfers {
  private deps: OutgoingDeps;
  private rows: OutgoingRows;
  private running = new Map<string, AbortController>();
  private progress = new Set<(transfer: Transfer) => void>();
  private settled = new Set<(record: OutgoingRecord) => void>();
  private lastBytes = new Map<string, number>();
  constructor(deps: OutgoingDeps) {
    this.deps = deps;
    this.rows = new OutgoingRows(deps.store);
  }
  onProgress(listener: (transfer: Transfer) => void): () => void {
    this.progress.add(listener);
    return () => this.progress.delete(listener);
  }
  onSettled(listener: (record: OutgoingRecord) => void): () => void {
    this.settled.add(listener);
    return () => this.settled.delete(listener);
  }
  get(transferId: string) {
    return this.rows.get(transferId);
  }
  undelivered() {
    return this.rows.undelivered();
  }
  markDelivered(transferId: string) {
    this.rows.markDelivered(transferId);
  }
  /** Running transfers and those settled in the last 24 hours, newest first. */
  list(): Transfer[] {
    return this.rows.list(this.deps.now() - retentionMs).map((record) => record.transfer);
  }
  /** The linked machine with this host id, by its stored id or by asking those without one. */
  async resolve(hostId: string): Promise<{ profile: RemoteProfile; name: string }> {
    const profiles = this.deps.profiles();
    const known = profiles.find((profile) => profile.hostId === hostId);
    if (known) return { profile: known, name: known.label ?? known.name };
    for (const profile of profiles.filter((entry) => !entry.hostId).slice(0, 16)) {
      const probe = await new TransferClient(this.deps.transport, profile)
        .probe()
        .catch(() => undefined);
      if (probe?.hostId === hostId) return { profile, name: probe.name };
    }
    throw new TransferError(
      "machine_not_linked",
      "This machine has no link to that one. Link them in Settings › Machines.",
    );
  }
  /** Checks the target takes transfers from this device, then starts one. A retry returns it. */
  async start(input: StartTransfer): Promise<Transfer> {
    const existing = this.rows.byCommand(input.commandId);
    if (existing) return existing.transfer;
    const profile = this.deps.profiles().find((entry) => entry.name === input.request.profile);
    if (!profile) throw new TransferError("machine_not_linked", "That machine isn't linked.");
    let accepts: boolean;
    try {
      accepts = (await new TransferClient(this.deps.transport, profile).probe()).accepts;
    } catch (error) {
      throw error instanceof MachineFailure && error.kind === "refused"
        ? new TransferError(
            "machine_forbidden",
            `${input.target.name} doesn't accept this machine's link. Link the machines again with Projects allowed.`,
          )
        : new TransferError(
            "machine_offline",
            `${input.target.name} is offline or unreachable. Wake it and start ace there.`,
          );
    }
    if (!accepts)
      throw new TransferError(
        "machine_forbidden",
        `${input.target.name} doesn't let this machine move projects there. Link the machines again with Projects allowed.`,
      );
    const at = this.deps.now();
    const transfer: Transfer = {
      transferId: `transfer-${this.deps.nextId()}`,
      commandId: input.commandId,
      kind: input.kind,
      workspaceId: input.workspaceId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      target: input.target,
      phase: "preparing",
      sentBytes: 0,
      startedAt: at,
      updatedAt: at,
    };
    this.rows.insert({
      transfer,
      request: input.request,
      plan: { source: input.source, name: input.name },
      delivered: !input.request.agent,
    });
    this.publish(transfer);
    this.run(transfer.transferId);
    return transfer;
  }
  /** After a restart: unsettled transfers carry on, and old rows and files go. */
  async recover(): Promise<void> {
    await ensureDirectory(this.deps.directory);
    for (const record of this.rows.unsettled()) this.run(record.transfer.transferId);
    for (const record of this.rows.expired(this.deps.now() - retentionMs)) {
      if (record.plan?.file) await removeQuietly(record.plan.file.path);
      this.rows.delete(record.transfer.transferId);
    }
  }
  close(): void {
    for (const controller of this.running.values()) controller.abort();
  }
  /** Stops a transfer before its thread exists there; after that its result stands. */
  async cancel(transferId: string): Promise<Transfer> {
    const record = this.rows.get(transferId);
    if (!record) throw new TransferError("not_found", "No such transfer.");
    if (!cancellable.has(record.transfer.phase)) return record.transfer;
    this.running.get(transferId)?.abort();
    const profile = this.deps.profiles().find((entry) => entry.name === record.request.profile);
    let there: IncomingTransfer | undefined;
    if (profile)
      there = await new TransferClient(this.deps.transport, profile)
        .call({ op: "cancel", transferId })
        .catch(() => undefined);
    if (there?.state === "completed" && there.result) return this.complete(record, there.result);
    return this.finish(record, { phase: "cancelled" });
  }
  private run(transferId: string): void {
    if (this.running.has(transferId)) return;
    const controller = new AbortController();
    this.running.set(transferId, controller);
    void this.drive(transferId, controller.signal)
      .catch(async (error: unknown) => {
        const record = this.rows.get(transferId);
        if (!record || terminal.has(record.transfer.phase) || controller.signal.aborted) return;
        const failure =
          error instanceof TransferError
            ? error
            : error instanceof MachineFailure && error.kind === "refused"
              ? new TransferError(
                  error.refusal ?? "machine_refused",
                  error.message.slice(0, 512) || "The other machine refused the transfer.",
                )
              : new TransferError("transfer_failed", "The transfer stopped unexpectedly.");
        await this.finish(record, {
          phase: "failed",
          error: { code: failure.code, message: failure.message },
        });
      })
      .finally(() => this.running.delete(transferId));
  }
  /** Retries calls that couldn't reach the target, until it has been gone too long. */
  private async reach<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    const since = this.deps.now();
    for (let delay = 250; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        return await call();
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof MachineFailure) || error.kind === "refused") throw error;
        if (this.deps.now() - since > (this.deps.offlineMs ?? 60 * 60 * 1000))
          throw new TransferError(
            "machine_offline",
            "The other machine stayed unreachable. Start the transfer again when it's back.",
          );
        await this.deps.sleep(delay, signal);
        signal.throwIfAborted();
      }
    }
  }
  private async drive(transferId: string, signal: AbortSignal): Promise<void> {
    let record = this.need(transferId);
    const profile = this.deps.profiles().find((entry) => entry.name === record.request.profile);
    if (!profile) throw new TransferError("machine_not_linked", "That machine isn't linked anymore.");
    const client = new TransferClient(this.deps.transport, profile);
    let plan = record.plan ?? { source: "", name: "" };
    let method = record.transfer.method;
    if (!method) {
      const planned = await planSource(this.deps.git, {
        transferId,
        source: plan.source,
        name: plan.name,
        includeChanges: record.request.includeChanges,
      });
      ({ method, plan } = planned);
      record = this.update(record, { method }, plan);
    }
    const origin = await this.deps.origin();
    let status = await this.reach(signal, () =>
      client.call(
        {
          op: "begin",
          transferId,
          origin,
          method,
          name: plan.name.slice(0, 256) || "project",
          ...(record.request.parent ? { parent: record.request.parent } : {}),
          ...(method === "remote" && plan.remote ? { remote: plan.remote } : {}),
        },
        signal,
      ),
    );
    for (;;) {
      signal.throwIfAborted();
      if (status.state === "completed" && status.result) {
        await this.complete(this.need(transferId), status.result);
        return;
      }
      if (status.state === "failed" || status.state === "cancelled") {
        await this.finish(this.need(transferId), {
          phase: status.state,
          ...(status.error ? { error: status.error } : {}),
        });
        return;
      }
      if (status.state === "importing" || status.state === "cloning") {
        record = this.update(this.need(transferId), {
          phase: status.state === "cloning" ? "cloning" : "importing",
        });
        await this.deps.sleep(500, signal);
        status = await this.reach(signal, () => client.call({ op: "status", transferId }, signal));
        continue;
      }
      // Receiving: write what travels once, then send what the target doesn't hold yet.
      if (status.method !== method) {
        method = status.method;
        if (plan.file) await removeQuietly(plan.file.path);
        const { file: _file, incremental: _incremental, ...rest } = plan;
        plan = rest;
        this.rows.dropFile(transferId, plan);
        record = this.update(this.need(transferId), { method, sentBytes: 0 });
      }
      const incremental = method === "remote" && status.hasOrigin !== false;
      const held = plan.file ? await fileBytes(plan.file.path) : 0;
      if (plan.incremental !== incremental || (plan.file && held !== plan.file.bytes)) {
        const file = await writeTransferFile(this.deps, {
          method,
          plan,
          file: join(this.deps.directory, `${transferId}.${method === "archive" ? "tar" : "bundle"}`),
          incremental,
          signal,
        });
        plan = { ...plan, ...(file ? { file } : {}), incremental };
        record = this.update(this.need(transferId), { totalBytes: file?.bytes ?? 0 }, plan);
      }
      record = this.update(this.need(transferId), { phase: "sending" });
      const file = plan.file;
      let offset = status.offset;
      while (file && offset < file.bytes) {
        signal.throwIfAborted();
        const data = await readAt(file.path, offset, Math.min(transferChunkBytes, file.bytes - offset));
        const from = offset;
        offset = await this.reach(signal, () => client.chunk(transferId, from, data, signal));
        record = this.bytes(this.need(transferId), offset);
      }
      const thread = record.request.thread;
      const threadId = record.transfer.threadId;
      if (threadId) await this.deps.threads.assertIdle(threadId);
      const carried: TransferThread | undefined =
        thread && threadId
          ? { ...thread, sourceThreadId: threadId, handoff: this.deps.threads.handoff(threadId) }
          : undefined;
      status = await this.reach(signal, () =>
        client.call(
          {
            op: "commit",
            transferId,
            ...(file ? { file: { bytes: file.bytes, sha256: file.sha256 } } : {}),
            ...(plan.branch ? { branch: plan.branch } : {}),
            ...(plan.head ? { head: plan.head } : {}),
            ...(plan.changes ? { changes: plan.changes } : {}),
            ...(carried ? { thread: carried } : {}),
          },
          signal,
        ),
      );
      record = this.update(this.need(transferId), { phase: "importing" });
    }
  }
  private need(transferId: string): OutgoingRecord {
    const record = this.rows.get(transferId);
    if (!record) throw new TransferError("not_found", "The transfer row is gone.");
    return record;
  }
  private update(
    record: OutgoingRecord,
    change: Partial<Transfer>,
    plan?: OutgoingRecord["plan"],
  ): OutgoingRecord {
    const transfer: Transfer = { ...record.transfer, ...change, updatedAt: this.deps.now() };
    this.rows.save(transfer, plan);
    const phaseChanged = transfer.phase !== record.transfer.phase;
    if (phaseChanged || change.method !== undefined || change.totalBytes !== undefined)
      this.publish(transfer);
    return { ...record, transfer, ...(plan ? { plan } : {}) };
  }
  /** Bytes moved: saved every time, pushed at most every 500 ms. */
  private bytes(record: OutgoingRecord, sentBytes: number): OutgoingRecord {
    const transfer: Transfer = { ...record.transfer, sentBytes, updatedAt: this.deps.now() };
    this.rows.save(transfer);
    const last = this.lastBytes.get(transfer.transferId) ?? 0;
    if (this.deps.now() - last >= 500) {
      this.lastBytes.set(transfer.transferId, this.deps.now());
      this.publish(transfer);
    }
    return { ...record, transfer };
  }
  private publish(transfer: Transfer): void {
    for (const listener of this.progress) listener(transfer);
  }
  private async complete(
    record: OutgoingRecord,
    result: NonNullable<IncomingTransfer["result"]>,
  ): Promise<Transfer> {
    if (record.transfer.threadId && result.threadId)
      this.deps.threads.continuedOn(record.transfer.threadId, {
        hostId: HostId.parse(record.request.hostId),
        name: record.transfer.target.name,
        threadId: result.threadId,
        at: this.deps.now(),
      });
    return this.finish(record, {
      phase: "completed",
      result,
      sentBytes: record.transfer.totalBytes ?? record.transfer.sentBytes,
    });
  }
  /** Settles a transfer once: its files and capture ref go, its listeners hear it. */
  private async finish(record: OutgoingRecord, change: Partial<Transfer>): Promise<Transfer> {
    const current = this.rows.get(record.transfer.transferId) ?? record;
    if (terminal.has(current.transfer.phase)) return current.transfer;
    const settled = this.update(current, change);
    this.lastBytes.delete(record.transfer.transferId);
    if (current.plan?.file) await removeQuietly(current.plan.file.path);
    if (current.plan?.changes)
      await this.deps.git.deleteRef(current.plan.source, current.plan.changes.ref).catch(() => undefined);
    this.deps.log("Transfer to another machine settled", {
      transferId: record.transfer.transferId,
      target: record.transfer.target.name,
      method: settled.transfer.method,
      outcome: settled.transfer.phase,
      ...(settled.transfer.error ? { code: settled.transfer.error.code } : {}),
    });
    for (const listener of this.settled) listener(settled);
    return settled.transfer;
  }
}
