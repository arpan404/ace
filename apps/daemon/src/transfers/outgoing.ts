import type { ProjectGitPolicy } from "@ace/git";
import { join } from "node:path";
import {
  HostId,
  maxTransferBytes,
  transferChunkBytes,
  type CommandId,
  type IncomingTransfer,
  type PortableHandoff,
  type ThreadContinuedOn,
  type ThreadId,
  type Transfer,
  type TransferBegin,
  type TransferMethod,
  type TransferOrigin,
  type TransferPhase,
  type TransferThread,
  type WorkspaceId,
} from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import { MachineFailure } from "../machines/transport.ts";
import type { Store } from "../store.ts";
import { TransferClient, type TransferTransport } from "./client.ts";
import { ensureDirectory, fileBytes, readAt, removeQuietly, removeStray } from "./files.ts";
import {
  OutgoingRows,
  type OutgoingRecord,
  type TransferPlan,
  type TransferRequest,
} from "./outgoing-rows.ts";
import { planSource, tooLarge, writeIgnoredFile, writeTransferFile } from "./prepare.ts";
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
  gitPolicy?: ProjectGitPolicy | undefined;
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
  /** Runs once the row exists and before any work, e.g. an agent's background hold. */
  hold?: ((transfer: Transfer) => void) | undefined;
}

const retentionMs = 24 * 60 * 60 * 1000;

/** The files a transfer wrote to send: the code's bundle or archive, and the ignored files. */
function payloads(plan: TransferPlan | undefined): string[] {
  return [
    ...(plan?.file ? [plan.file.path] : []),
    ...(plan?.ignored && "path" in plan.ignored ? [plan.ignored.path] : []),
  ];
}

/** The ignored files are already packed, or known to be none, and still whole on disk. */
async function ignoredHeld(plan: TransferPlan): Promise<boolean> {
  if (!plan.ignored) return false;
  if (!("path" in plan.ignored)) return true;
  return (await fileBytes(plan.ignored.path)) === plan.ignored.bytes;
}
const terminal = new Set<TransferPhase>(["completed", "failed", "cancelled"]);
const cancellable = new Set<TransferPhase>(["preparing", "cloning", "sending", "importing"]);

/**
 * The sending side of transfers (ADR 0101): one durable row per transfer, sent straight to the
 * target over its fleet link, resumed from the target's acknowledged offset after a restart or a
 * lost connection. Progress goes out on every phase change and at most every 500 ms of bytes.
 */
export class OutgoingTransfers {
  private deps: OutgoingDeps;
  private rows: OutgoingRows;
  private running = new Map<string, AbortController>();
  private flights = new Set<Promise<void>>();
  /** Each running drive, so a cancel can wait for it to stop before asking the target. */
  private drives = new Map<string, Promise<void>>();
  private closed = false;
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
      "This machine has no link to that one. Link them in Settings › Fleet.",
    );
  }
  /** A machine by its profile name, as `machines` lists it: its host id and display name. */
  async resolveProfile(machine: string): Promise<{ hostId: HostId; name: string }> {
    const profile = this.deps.profiles().find((entry) => entry.name === machine);
    if (!profile)
      throw new TransferError(
        "machine_not_linked",
        `No linked machine named ${machine.slice(0, 64)}. Call machines for the names.`,
      );
    if (profile.hostId) return { hostId: profile.hostId, name: profile.label ?? profile.name };
    try {
      const probe = await new TransferClient(this.deps.transport, profile).probe();
      return { hostId: probe.hostId, name: probe.name };
    } catch {
      throw new TransferError(
        "machine_offline",
        `${machine.slice(0, 64)} is offline or unreachable.`,
      );
    }
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
      options: {
        includeChanges: input.request.includeChanges,
        includeIgnored: input.request.includeIgnored,
        ...(input.request.parent ? { parent: input.request.parent } : {}),
      },
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
    input.hold?.(transfer);
    this.publish(transfer);
    this.run(transfer.transferId);
    return transfer;
  }
  /**
   * After a restart: unsettled transfers carry on, and old rows and files go. An agent's row
   * stays until its result is delivered (see `OutgoingRows.expired`).
   */
  async recover(): Promise<void> {
    await ensureDirectory(this.deps.directory);
    const unsettled = this.rows.unsettled();
    // Payloads a crash left behind for transfers that are settled or gone.
    const live = unsettled.map((record) => `${record.transfer.transferId}.`);
    await removeStray(this.deps.directory, (name) => live.some((id) => name.startsWith(id)));
    for (const record of unsettled) this.run(record.transfer.transferId);
    for (const record of this.rows.expired(this.deps.now() - retentionMs)) {
      for (const path of payloads(record.plan)) await removeQuietly(path);
      this.rows.delete(record.transfer.transferId);
    }
  }
  /** Stops sending; a restart resumes from the target's acknowledged offset. */
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled(this.flights);
  }
  /**
   * Stops a transfer before its thread exists there; after that its result stands. Only the
   * target's answer settles it: `cancelled` when it confirms, its result once complete. A target
   * past the cutoff (`too_late`) or one that can't be asked leaves the outcome open: the transfer
   * carries on and its status tells how it ends, and the cancel fails with that code.
   */
  async cancel(transferId: string): Promise<Transfer> {
    const record = this.rows.get(transferId);
    if (!record) throw new TransferError("not_found", "No such transfer.");
    if (!cancellable.has(record.transfer.phase)) return record.transfer;
    this.running.get(transferId)?.abort();
    // Nothing more is sent while the target decides.
    await this.drives.get(transferId);
    const profile = this.deps.profiles().find((entry) => entry.name === record.request.profile);
    let there: IncomingTransfer | undefined;
    let refusal: string | undefined;
    if (profile)
      there = await new TransferClient(this.deps.transport, profile)
        .call({ op: "cancel", transferId })
        .catch((error: unknown) => {
          if (error instanceof MachineFailure && error.kind === "refused") refusal = error.refusal;
          return undefined;
        });
    if (there?.state === "cancelled") return this.finish(record, { phase: "cancelled" });
    // The target waited for an import past its cutoff and answers with how it ended.
    if (there?.state === "completed" && there.result) return this.complete(record, there.result);
    if (there?.state === "failed")
      return this.finish(record, {
        phase: "failed",
        ...(there.error ? { error: there.error } : {}),
      });
    // The target holds nothing of it: nothing can land there.
    if (refusal === "not_found") return this.finish(record, { phase: "cancelled" });
    // Unknown here: never assumed cancelled. Status says how it ends.
    this.run(transferId);
    const name = record.transfer.target.name;
    if (refusal === "too_late")
      throw new TransferError(
        "too_late",
        `It already reached ${name}; the work is landing there and can't be cancelled.`,
      );
    throw new TransferError(
      "cancel_unconfirmed",
      `${name} didn't confirm the cancel, so the transfer carries on. Try cancelling again.`,
    );
  }
  private run(transferId: string): void {
    if (this.running.has(transferId) || this.closed) return;
    const controller = new AbortController();
    this.running.set(transferId, controller);
    const flight = this.drive(transferId, controller.signal)
      .catch(async (error: unknown) => {
        if (this.closed) return;
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
      .catch((error: unknown) =>
        this.deps.log("Transfer could not settle", { transferId, error: String(error) }),
      )
      .finally(() => {
        this.running.delete(transferId);
        this.flights.delete(flight);
        if (this.drives.get(transferId) === flight) this.drives.delete(transferId);
      });
    this.flights.add(flight);
    this.drives.set(transferId, flight);
  }
  /**
   * Retries calls that couldn't reach the target, or that it answered while starting or stopping,
   * until it has been gone too long.
   */
  private async reach<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    const since = this.deps.now();
    for (let delay = 250; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        return await call();
      } catch (error) {
        if (signal.aborted) throw error;
        // A target starting up or shutting down answers `unavailable`: wait for it like a lost link.
        const passing =
          error instanceof MachineFailure &&
          (error.kind !== "refused" || error.refusal === "unavailable");
        if (!passing) throw error;
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
    if (!profile)
      throw new TransferError("machine_not_linked", "That machine isn't linked anymore.");
    const client = new TransferClient(this.deps.transport, profile);
    let plan = record.plan ?? { source: "", name: "" };
    let method: TransferMethod;
    if (record.transfer.method) method = record.transfer.method;
    else {
      const planned = await planSource(
        this.deps.git,
        {
          transferId,
          source: plan.source,
          name: plan.name,
          includeChanges: record.request.includeChanges,
        },
        this.deps.gitPolicy,
      );
      ({ method, plan } = planned);
      record = this.update(record, { method }, plan);
    }
    const origin = await this.deps.origin();
    const begin: TransferBegin = {
      op: "begin",
      transferId,
      origin,
      method,
      name: plan.name.slice(0, 256) || "project",
      ...(record.request.parent ? { parent: record.request.parent } : {}),
      ...(plan.remote ? { remote: plan.remote } : {}),
    };
    // The target lands a project sent again in the copy it made before, by the source's id. A
    // target older than that field refuses it: it is asked again without, as it knows.
    const named: TransferBegin = { ...begin, sourceWorkspaceId: record.transfer.workspaceId };
    let status = await this.reach(signal, () => client.call(named, signal)).catch(
      (error: unknown) => {
        if (
          error instanceof MachineFailure &&
          error.kind === "refused" &&
          error.refusal === "invalid"
        )
          return this.reach(signal, () => client.call(begin, signal));
        throw error;
      },
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
          file: join(
            this.deps.directory,
            `${transferId}.${method === "archive" ? "tar" : "bundle"}`,
          ),
          incremental,
          includeIgnored: record.request.includeIgnored,
          signal,
        });
        plan = { ...plan, ...(file ? { file } : {}), incremental };
        record = this.update(this.need(transferId), {}, plan);
      }
      // Files Git ignores travel as their own archive, to a target that says it takes them.
      const takesIgnored =
        record.request.includeIgnored && method !== "archive" && status.ignoredOffset !== undefined;
      if (takesIgnored && !(await ignoredHeld(plan))) {
        const ignored = await writeIgnoredFile(this.deps, {
          source: plan.source,
          file: join(this.deps.directory, `${transferId}.ignored.tar`),
          room: maxTransferBytes - (plan.file?.bytes ?? 0),
          signal,
        });
        plan = { ...plan, ignored: ignored ?? { files: 0 } };
        record = this.update(
          this.need(transferId),
          ignored ? { ignoredFiles: { files: ignored.files, bytes: ignored.bytes } } : {},
          plan,
        );
      }
      const file = plan.file;
      const ignored =
        takesIgnored && plan.ignored && "path" in plan.ignored ? plan.ignored : undefined;
      const codeBytes = file?.bytes ?? 0;
      const ignoredBytes = ignored?.bytes ?? 0;
      const total = codeBytes + ignoredBytes;
      if (total > maxTransferBytes) throw tooLarge(total);
      if (record.transfer.totalBytes !== total)
        record = this.update(this.need(transferId), { totalBytes: total });
      record = this.update(this.need(transferId), { phase: "sending" });
      const sent = { code: status.offset, ignored: status.ignoredOffset ?? 0 };
      const upload = async (part: "code" | "ignored", path: string, bytes: number) => {
        while (sent[part] < bytes) {
          signal.throwIfAborted();
          const from = sent[part];
          const data = await readAt(path, from, Math.min(transferChunkBytes, bytes - from));
          sent[part] = await this.reach(signal, () =>
            client.chunk(transferId, from, data, signal, part),
          );
          record = this.bytes(this.need(transferId), sent.code + sent.ignored);
        }
      };
      await upload("code", file?.path ?? "", codeBytes);
      await upload("ignored", ignored?.path ?? "", ignoredBytes);
      const thread = record.request.thread;
      const threadId = record.transfer.threadId;
      // An agent continuing its own thread is the work that is still running; it hands over now.
      if (threadId && !record.request.agent?.self) await this.deps.threads.assertIdle(threadId);
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
            ...(ignored
              ? {
                  ignored: { bytes: ignored.bytes, sha256: ignored.sha256, files: ignored.files },
                }
              : {}),
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
  /**
   * Settles a transfer once: its files and capture refs go first, so a transfer that reads
   * settled has nothing of it left here; then the row settles and its listeners hear it.
   */
  private async finish(record: OutgoingRecord, change: Partial<Transfer>): Promise<Transfer> {
    const current = this.rows.get(record.transfer.transferId) ?? record;
    if (terminal.has(current.transfer.phase)) return current.transfer;
    for (const path of payloads(current.plan)) await removeQuietly(path);
    for (const ref of [current.plan?.changes?.ref, current.plan?.pinned])
      if (ref && current.plan)
        await this.deps.git.deleteRef(current.plan.source, ref).catch((error: unknown) =>
          this.deps.log("Transfer ref not deleted", {
            transferId: record.transfer.transferId,
            error: String(error),
          }),
        );
    // Another settle may have won while this one cleaned up.
    const now = this.rows.get(record.transfer.transferId) ?? current;
    if (terminal.has(now.transfer.phase)) return now.transfer;
    const settled = this.update(now, change);
    this.lastBytes.delete(record.transfer.transferId);
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
