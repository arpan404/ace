import { validateCloneUrl, type ProjectGitPolicy } from "@ace/git";
import { join } from "node:path";
import {
  WorkspaceId,
  maxTransferBytes,
  transferChunkBytes,
  type Device,
  type IncomingTransfer,
  type MachineTransferCall,
  type TransferBegin,
  type TransferCommit,
} from "@ace/protocol";
import { TargetRefusal } from "../machines/target-refusal.ts";
import { IncomingRows, type IncomingRecord } from "./incoming-rows.ts";
import {
  appendAt,
  ensureDirectory,
  fileBytes,
  fileDigest,
  removeQuietly,
  removeStray,
} from "./files.ts";
import { neverPlaced } from "./ignored-files.ts";
import {
  NeedsFullBundle,
  landTransfer,
  type TargetProjects,
  type TargetThreadStarter,
} from "./landing.ts";
import { TransferError, type TransferArchive, type TransferGit } from "./ports.ts";
import type { Store } from "../store.ts";

export interface IncomingDeps {
  store: Store;
  /** Where incoming files wait: `<data>/transfers/incoming`. */
  directory: string;
  git: TransferGit;
  gitPolicy?: ProjectGitPolicy | undefined;
  archive: TransferArchive;
  projects: TargetProjects;
  threads: TargetThreadStarter;
  now(): number;
  log(message: string, fields: Record<string, unknown>): void;
}

const retentionMs = 24 * 60 * 60 * 1000;
const settled = new Set(["completed", "failed", "cancelled"]);

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof TransferError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === "AbortError")
    return { code: "transfer_cancelled", message: "The transfer was cancelled." };
  return { code: "import_failed", message: "This machine couldn't import the transfer." };
}

/**
 * The receiving side of transfers (ADR 0099). Rows and files are keyed by transfer id, so a
 * repeated begin, chunk or commit is answered from what is already here. A failed or cancelled
 * import never leaves a project registered and removes only the folders it made.
 */
export class IncomingTransfers {
  private deps: IncomingDeps;
  private rows: IncomingRows;
  private running = new Map<string, AbortController>();
  private flights = new Set<Promise<void>>();
  private closed = false;
  private writes = new Map<string, Promise<unknown>>();
  private held = new Set<string>();
  constructor(deps: IncomingDeps) {
    this.deps = deps;
    this.rows = new IncomingRows(deps.store);
  }
  /** After a restart: imports that were running start again from the file that is still here. */
  async recover(): Promise<void> {
    await ensureDirectory(this.deps.directory);
    for (const record of this.rows.unsettled()) {
      await this.rollback(record);
      this.import(this.rows.get(record.transferId) ?? record);
    }
    // Files a crash left behind for transfers that are settled or gone.
    const live = this.rows.live().map((transferId) => `${transferId}.`);
    await removeStray(this.deps.directory, (name) => live.some((id) => name.startsWith(id)));
    await this.sweep();
  }
  /** Stops importing; a restart rolls back what an import made and runs it again. */
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled(this.flights);
  }
  private file(transferId: string) {
    return join(this.deps.directory, `${transferId}.part`);
  }
  /** The archive of files Git ignores, uploaded beside the code (`part=ignored`). */
  private ignoredFile(transferId: string) {
    return join(this.deps.directory, `${transferId}.ignored.part`);
  }
  private async removeFiles(transferId: string) {
    await removeQuietly(this.file(transferId));
    await removeQuietly(this.ignoredFile(transferId));
  }
  async view(record: IncomingRecord): Promise<IncomingTransfer> {
    const receiving = record.state === "receiving";
    return {
      transferId: record.transferId,
      state: record.state,
      method: record.method,
      offset: receiving ? await fileBytes(this.file(record.transferId)) : 0,
      // Always present: this machine takes ignored files.
      ignoredOffset: receiving ? await fileBytes(this.ignoredFile(record.transferId)) : 0,
      ...(record.hasOrigin === undefined ? {} : { hasOrigin: record.hasOrigin }),
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }
  /** One device's own transfer; another device's id reads as unknown. */
  private owned(device: Device, transferId: string): IncomingRecord {
    const record = this.rows.get(transferId);
    if (!record || record.deviceId !== device.id)
      throw new TargetRefusal("not_found", "This machine has no such transfer.");
    return record;
  }
  async call(
    device: Device,
    call: Exclude<MachineTransferCall, { op: "probe" }>,
  ): Promise<IncomingTransfer> {
    switch (call.op) {
      case "begin":
        return this.begin(device, call);
      case "status":
        return this.view(this.owned(device, call.transferId));
      case "commit":
        return this.commit(device, call);
      case "cancel":
        return this.cancel(device, call.transferId);
    }
  }
  private async begin(device: Device, call: TransferBegin): Promise<IncomingTransfer> {
    if (call.remote) (this.deps.gitPolicy?.validateUrl ?? validateCloneUrl)(call.remote.url);
    const existing = this.rows.get(call.transferId);
    if (existing) return this.view(this.owned(device, call.transferId));
    await this.sweep();
    await ensureDirectory(this.deps.directory);
    const reused =
      call.method === "remote" && call.remote
        ? await this.sameOrigin(call.remote.normalized)
        : undefined;
    const record: IncomingRecord = {
      transferId: call.transferId,
      deviceId: device.id,
      state: "receiving",
      method: call.method,
      ...(call.method === "remote" ? { hasOrigin: true } : {}),
      begin: call,
      ...(reused ? { workspaceId: reused } : {}),
      updatedAt: this.deps.now(),
    };
    this.rows.insert(record, this.deps.now());
    this.deps.log("Transfer from another machine", {
      transferId: call.transferId,
      device: device.name,
      fromMachine: call.origin.hostName,
      method: call.method,
      reused: Boolean(reused),
    });
    return this.view(record);
  }
  /** A project here whose origin is the same repository. */
  private async sameOrigin(normalized: string): Promise<WorkspaceId | undefined> {
    for (const project of this.deps.projects.list().slice(0, 64)) {
      const origin = await this.deps.git.transferOrigin(project.path).catch(() => undefined);
      if (origin && origin.normalized === normalized) return project.workspaceId;
    }
    return undefined;
  }
  /** One piece of the upload at `offset`; out of order answers what is held, unchanged. */
  async chunk(
    device: Device,
    transferId: string,
    offset: number,
    data: Buffer,
    part: "code" | "ignored" = "code",
  ) {
    const record = this.owned(device, transferId);
    if (data.length > transferChunkBytes) throw new TargetRefusal("invalid", "Chunk too large.");
    if (record.state !== "receiving")
      throw new TargetRefusal("invalid", "This transfer isn't receiving bytes.");
    const file = part === "ignored" ? this.ignoredFile(transferId) : this.file(transferId);
    const previous = this.writes.get(transferId) ?? Promise.resolve();
    const write = previous.then(() => appendAt(file, offset, data));
    this.writes.set(
      transferId,
      write.catch(() => undefined),
    );
    return { offset: await write };
  }
  private async commit(device: Device, call: TransferCommit): Promise<IncomingTransfer> {
    const record = this.owned(device, call.transferId);
    if (record.state !== "receiving") return this.view(record);
    const file = this.file(call.transferId);
    if (call.file) {
      const bytes = await fileBytes(file);
      if (bytes !== call.file.bytes)
        throw new TargetRefusal("invalid", `Holding ${bytes} of ${call.file.bytes} bytes.`);
      if ((await fileDigest(file)) !== call.file.sha256) {
        await this.removeFiles(call.transferId);
        this.settle(record.transferId, "failed", {
          code: "transfer_corrupt",
          message: "The file arrived damaged. Start the transfer again.",
        });
        return this.view(this.owned(device, call.transferId));
      }
    } else if (record.method !== "remote")
      throw new TargetRefusal("invalid", "This method needs a file.");
    if (call.ignored) {
      if ((call.file?.bytes ?? 0) + call.ignored.bytes > maxTransferBytes)
        throw new TargetRefusal("invalid", "The transfer is larger than a transfer may be.");
      const ignored = this.ignoredFile(call.transferId);
      const bytes = await fileBytes(ignored);
      if (bytes !== call.ignored.bytes)
        throw new TargetRefusal("invalid", `Holding ${bytes} of ${call.ignored.bytes} bytes.`);
      // Checked before anything is written; the names inside are never read until it matches.
      if ((await fileDigest(ignored)) !== call.ignored.sha256) {
        await this.removeFiles(call.transferId);
        this.settle(record.transferId, "failed", {
          code: "transfer_corrupt",
          message: "The file arrived damaged. Start the transfer again.",
        });
        return this.view(this.owned(device, call.transferId));
      }
    }
    this.rows.update(call.transferId, { state: "importing", commit: call }, this.deps.now());
    const importing = this.owned(device, call.transferId);
    this.import(importing);
    return this.view(importing);
  }
  private import(record: IncomingRecord): void {
    if (this.running.has(record.transferId)) return;
    const controller = new AbortController();
    this.running.set(record.transferId, controller);
    void this.run(record, controller.signal).finally(() => this.running.delete(record.transferId));
  }
  private async run(record: IncomingRecord, signal: AbortSignal): Promise<void> {
    const file = this.file(record.transferId);
    const hasFile = Boolean(record.commit?.file);
    const ignored = record.commit?.ignored ? this.ignoredFile(record.transferId) : undefined;
    let ignoredSkipped = 0;
    const mine: string[] = [];
    try {
      const result = await landTransfer(
        {
          git: this.deps.git,
          gitPolicy: this.deps.gitPolicy,
          archive: this.deps.archive,
          projects: this.deps.projects,
          threads: this.deps.threads,
          held: this.held,
          made: (change) => {
            if (change.createdPath) mine.push(change.createdPath);
            this.rows.update(record.transferId, change, this.deps.now());
          },
          attempt: String(this.deps.now()),
          // Ignored files go in once the checkout is there, never over a file it already has.
          ...(ignored
            ? {
                landed: async (path: string) => {
                  const merged = await this.deps.archive.mergeArchive(ignored, path, {
                    signal,
                    exclude: neverPlaced,
                  });
                  ignoredSkipped += merged.skipped;
                },
              }
            : {}),
        },
        record,
        hasFile ? file : undefined,
        signal,
      );
      if (this.rows.get(record.transferId)?.state !== "importing") return;
      this.rows.update(
        record.transferId,
        {
          state: "completed",
          result: { ...result, ...(ignored ? { ignoredSkipped } : {}) },
          createdPath: undefined,
          registeredId: undefined,
        },
        this.deps.now(),
      );
      await this.removeFiles(record.transferId);
    } catch (error) {
      // Shutting down: the row stays importing, and the next start rolls back and retries.
      if (this.closed) return;
      const current = this.rows.get(record.transferId) ?? record;
      await this.rollback(current);
      if (current.state !== "importing") return;
      if (error instanceof NeedsFullBundle && current.method === "remote") {
        // Origin's history isn't usable here: the sender sends the whole repository instead.
        await removeQuietly(file);
        this.rows.update(
          record.transferId,
          { state: "receiving", method: "bundle", hasOrigin: false, commit: undefined },
          this.deps.now(),
        );
        return;
      }
      await this.removeFiles(record.transferId);
      this.settle(record.transferId, "failed", failure(error));
    } finally {
      for (const path of mine) this.held.delete(path);
    }
  }
  /** Unregisters a project this transfer registered and removes the folders it made. */
  private async rollback(record: IncomingRecord): Promise<void> {
    if (record.registeredId)
      await this.deps.projects
        .unregister(WorkspaceId.parse(record.registeredId))
        .catch(() => undefined);
    if (record.createdPath) await removeQuietly(record.createdPath);
    this.rows.update(
      record.transferId,
      { createdPath: undefined, registeredId: undefined },
      this.deps.now(),
    );
  }
  private settle(
    transferId: string,
    state: "failed" | "cancelled",
    error?: { code: string; message: string },
  ) {
    this.rows.update(transferId, { state, ...(error ? { error } : {}) }, this.deps.now());
  }
  /** Cancel works until the import has made the thread; after that the result stands. */
  async cancel(device: Device, transferId: string): Promise<IncomingTransfer> {
    const record = this.owned(device, transferId);
    if (settled.has(record.state)) return this.view(record);
    this.rows.update(transferId, { state: "cancelled" }, this.deps.now());
    this.running.get(transferId)?.abort();
    await this.writes.get(transferId);
    if (!this.running.has(transferId)) await this.rollback(record);
    await this.removeFiles(transferId);
    return this.view(this.owned(device, transferId));
  }
  /** Settled rows and their files go after 24 hours. */
  private async sweep(): Promise<void> {
    for (const record of this.rows.expired(this.deps.now() - retentionMs)) {
      await this.removeFiles(record.transferId);
      this.rows.delete(record.transferId);
    }
  }
}
