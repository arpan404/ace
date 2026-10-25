import { GitError, validateCloneUrl, type ProjectGitPolicy } from "@ace/git";
import { basename, dirname, join } from "node:path";
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
  removeIfOwned,
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

/** Git failures a person can act on, in their words; the rest are `import_failed`. */
const gitFailures: Partial<Record<string, { code: string; message: string }>> = {
  ref_conflict: {
    code: "branch_unavailable",
    message: "The branch's name and every name it could land under are taken on this machine.",
  },
  dirty_worktree: {
    code: "changes_conflict",
    message: "The project here has its own changes to the same files. Commit or stash them first.",
  },
  branch_checked_out: {
    code: "branch_unavailable",
    message: "The branch is checked out in another worktree on this machine.",
  },
  head_moved: {
    code: "branch_diverged",
    message: "The branch here has commits the transfer doesn't. Try again to land it beside them.",
  },
};

/** A name in a held folder, without following it. */
function exists(parent: { handle: { metadata(name: string): unknown } }, name: string): boolean {
  try {
    parent.handle.metadata(name);
    return true;
  } catch {
    return false;
  }
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof TransferError) return { code: error.code, message: error.message };
  const known = error instanceof GitError ? gitFailures[error.code] : undefined;
  if (known) return known;
  if (error instanceof Error && error.name === "AbortError")
    return { code: "transfer_cancelled", message: "The transfer was cancelled." };
  return { code: "import_failed", message: "This machine couldn't import the transfer." };
}

/**
 * The receiving side of transfers (ADR 0101). Rows and files are keyed by transfer id, so a
 * repeated begin, chunk or commit is answered from what is already here. A failed or cancelled
 * import never leaves a project registered and removes only the folders it made.
 */
export class IncomingTransfers {
  private deps: IncomingDeps;
  private rows: IncomingRows;
  private running = new Map<string, AbortController>();
  /** Each running import's promise, so cancel and shutdown can wait for it. */
  private imports = new Map<string, Promise<void>>();
  /** Imports past their cutoff: a cancel waits for their result instead. */
  private past = new Set<string>();
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
      // Past the cutoff the result stands: finish setting it up instead of undoing it.
      if (record.result) {
        // Left importing when it fails: the next start tries the setup again.
        await this.complete(record, record.result);
        continue;
      }
      await this.rollback(record);
      this.import(this.rows.get(record.transferId) ?? record);
    }
    // Rows a cancel or failure settled before their rollback finished.
    for (const record of this.rows.leftovers()) await this.rollback(record);
    // Files a crash left behind for transfers that are settled or gone.
    const live = this.rows.live().map((transferId) => `${transferId}.`);
    await removeStray(this.deps.directory, (name) => live.some((id) => name.startsWith(id)));
    await this.sweep();
  }
  /** Stops importing; a restart rolls back what an import made and runs it again. */
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled([...this.imports.values(), ...this.writes.values()]);
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
    if (this.closed) throw new TargetRefusal("unavailable", "This machine is shutting down.");
    const file = part === "ignored" ? this.ignoredFile(transferId) : this.file(transferId);
    const other = part === "ignored" ? this.file(transferId) : this.ignoredFile(transferId);
    const previous = this.writes.get(transferId) ?? Promise.resolve();
    // Serialised per transfer, so the cap counts both payloads as they stand before this write.
    const write = previous.then(async () => {
      const held = await fileBytes(file);
      if (held === offset && held + data.length + (await fileBytes(other)) > maxTransferBytes)
        throw new TargetRefusal(
          "invalid",
          "The transfer is larger than a transfer may be (20 GiB with the files Git ignores).",
        );
      return appendAt(file, offset, data);
    });
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
    if (this.running.has(record.transferId) || this.closed) return;
    const controller = new AbortController();
    this.running.set(record.transferId, controller);
    const flight = this.run(record, controller.signal).finally(() => {
      this.running.delete(record.transferId);
      this.imports.delete(record.transferId);
      this.past.delete(record.transferId);
    });
    this.imports.set(record.transferId, flight);
  }
  private async run(record: IncomingRecord, signal: AbortSignal): Promise<void> {
    const file = this.file(record.transferId);
    const hasFile = Boolean(record.commit?.file);
    const ignored = record.commit?.ignored ? this.ignoredFile(record.transferId) : undefined;
    let ignoredSkipped = 0;
    const mine: string[] = [];
    try {
      const landed = await landTransfer(
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
                landed: async (destination, landing: AbortSignal) => {
                  const merged = await this.deps.archive.mergeArchive(ignored, destination, {
                    signal: landing,
                    exclude: neverPlaced,
                  });
                  ignoredSkipped += merged.skipped;
                },
              }
            : {}),
          cutoff: () => {
            // Synchronous with cancel's check: one of them wins, never both.
            if (this.rows.get(record.transferId)?.state !== "importing")
              throw new TransferError("transfer_cancelled", "The transfer was cancelled.");
            this.past.add(record.transferId);
          },
          created: (result) =>
            this.rows.update(
              record.transferId,
              { result: { ...result, ...(ignored ? { ignoredSkipped } : {}) } },
              this.deps.now(),
            ),
        },
        record,
        hasFile ? file : undefined,
        signal,
      );
      this.finish(this.rows.get(record.transferId) ?? record, {
        ...landed,
        ...(ignored ? { ignoredSkipped } : {}),
      });
      await this.removeFiles(record.transferId);
    } catch (error) {
      const current = this.rows.get(record.transferId) ?? record;
      // Past the cutoff, the result stands and is never rolled back: what failed came after it
      // (the thread's setup, or releasing its worktree). Setting it up is tried once more now;
      // otherwise the row stays importing and the next start finishes it.
      if (current.result) {
        await this.complete(current, current.result);
        return;
      }
      // Landing undid what it made; a crash mid-way is undone by the next start.
      await this.rollback(current);
      // Shutting down: the row stays importing, and the next start runs it again.
      if (this.closed) return;
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
  /** `finish`, keeping the row importing (for the next start) when the setup fails again. */
  private async complete(
    record: IncomingRecord,
    result: NonNullable<IncomingRecord["result"]>,
  ): Promise<void> {
    try {
      this.finish(record, result);
      await this.removeFiles(record.transferId);
    } catch (error) {
      this.deps.log("Transfer setup not finished", {
        transferId: record.transferId,
        error: String(error),
      });
    }
  }
  /** Completes an import past its cutoff: the thread's setup and the row in one transaction. */
  private finish(record: IncomingRecord, result: NonNullable<IncomingRecord["result"]>): void {
    const complete = () =>
      this.rows.update(
        record.transferId,
        {
          state: "completed",
          result,
          createdPath: undefined,
          createdId: undefined,
          registeredId: undefined,
        },
        this.deps.now(),
      );
    const thread = record.commit?.thread;
    if (thread && result.threadId)
      this.deps.threads.setUp(
        {
          threadId: result.threadId,
          thread,
          machine: { hostId: record.begin.origin.hostId, name: record.begin.origin.hostName },
        },
        complete,
      );
    else complete();
  }
  /**
   * Unregisters a project this transfer registered and removes the folder it made, through the
   * folder's parent, validated again against the allowed roots and held open, and only while the
   * name still leads to the folder with the identity recorded when it was made. A folder whose
   * ownership can't be shown (reserved, but a crash came before its identity was recorded) or
   * that can't be removed is left in place and recorded, never removed by guess.
   */
  private async rollback(record: IncomingRecord): Promise<void> {
    if (record.registeredId)
      await this.deps.projects
        .unregister(WorkspaceId.parse(record.registeredId))
        .catch(() => undefined);
    const path = record.createdPath;
    if (path) {
      const parent = await this.deps.projects.parent(dirname(path)).catch(() => undefined);
      let left = false;
      try {
        if (!parent || parent.path !== dirname(path)) left = true;
        else if (record.createdId) {
          try {
            removeIfOwned(parent, basename(path), record.createdId);
          } catch {
            left = true;
          }
        } else left = exists(parent, basename(path));
      } finally {
        await parent?.close();
      }
      if (left) {
        this.rows.leftInPlace(record.transferId, path, this.deps.now());
        this.deps.log("Transfer folder left in place", { transferId: record.transferId });
      }
    }
    this.rows.update(
      record.transferId,
      { createdPath: undefined, createdId: undefined, registeredId: undefined },
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
  /**
   * Cancel works until the import's cutoff: the thread being made or, without one, everything
   * having landed. A running import is stopped and awaited, and what it made is undone; after the
   * cutoff the cancel waits and answers with the completed result.
   */
  async cancel(device: Device, transferId: string): Promise<IncomingTransfer> {
    const record = this.owned(device, transferId);
    if (settled.has(record.state)) return this.view(record);
    const flight = this.imports.get(transferId);
    if (this.past.has(transferId) || record.result) {
      // Too late: the import passed its cutoff. Its result once it completes, else a refusal;
      // the sender learns the rest through status.
      await flight;
      const now = this.owned(device, transferId);
      if (now.state === "completed") return this.view(now);
      throw new TargetRefusal(
        "too_late",
        "The transfer can no longer be cancelled: the work is landing on this machine.",
      );
    }
    this.rows.update(transferId, { state: "cancelled" }, this.deps.now());
    this.running.get(transferId)?.abort();
    await flight;
    await this.writes.get(transferId);
    await this.rollback(this.owned(device, transferId));
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
