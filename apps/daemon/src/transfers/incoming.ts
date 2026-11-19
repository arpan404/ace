import { GitError, validateCloneUrl, type ProjectGitPolicy } from "@ace/git";
import { rm } from "node:fs/promises";
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
import { OriginCache, sameOriginProject } from "../project-origin.ts";
import { IncomingRows, type IncomingRecord } from "./incoming-rows.ts";
import {
  appendAt,
  ensureDirectory,
  fileBytes,
  fileDigest,
  removeIfOwned,
  removeQuietly,
  removeStray,
  transferOfFile,
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
import type { TransferIdentities } from "./identity.ts";
import { finalFolder, type LiveTarget } from "./live/target.ts";
import { persist } from "./retry.ts";

export interface IncomingDeps {
  store: Store;
  /** Where incoming files wait: `<data>/transfers/incoming`. */
  directory: string;
  git: TransferGit;
  gitPolicy?: ProjectGitPolicy | undefined;
  archive: TransferArchive;
  projects: TargetProjects;
  threads: TargetThreadStarter;
  /** Logical project identity (ADR 0180); without it, this target says it keeps none. */
  identities?: TransferIdentities | undefined;
  /** Threads moved while working (ADR 0191); without it, this target takes none. */
  live?: LiveTarget | undefined;
  now(): number;
  /** Waits between retries of a setup or a start that failed; real time by default. */
  sleep?(ms: number): Promise<void>;
  log(message: string, fields: Record<string, unknown>): void;
}

const retentionMs = 24 * 60 * 60 * 1000;
/** The most registrations, most recently used first, a begin reads origins of. */
const originBudget = 256;
const settled = new Set(["completed", "failed", "cancelled"]);
/** What a receiving transfer holds beside its id: the code, the ignored files, the final payload. */
const incomingSuffixes = [".part", ".ignored.part", ".final.part", ".final.d"];

/** Runs `each` over every row `page` returns, page after page by transfer id, to the end. */
async function batches(
  page: (after: string) => IncomingRecord[],
  each: (record: IncomingRecord) => Promise<void>,
): Promise<void> {
  for (let after = ""; ;) {
    const batch = page(after);
    for (const record of batch) await each(record);
    const last = batch.at(-1);
    if (!last || batch.length < 64) return;
    after = last.transferId;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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
    message: "The branch here has commits the transfer doesn't, and it couldn't land beside them.",
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
  /** Setups and starts being tried again, by key, so each runs once at a time. */
  private retries = new Set<string>();
  /** Origins and remotes read for begins, kept briefly so repeated begins don't ask Git again. */
  private origins: OriginCache;
  constructor(deps: IncomingDeps) {
    this.deps = deps;
    this.rows = new IncomingRows(deps.store);
    this.origins = new OriginCache(deps.git, () => deps.now());
  }
  /** After a restart: imports that were running start again from the file that is still here. */
  async recover(): Promise<void> {
    await ensureDirectory(this.deps.directory);
    // Rows from before the side tables are indexed first, in pages (ADR 0170).
    await this.rows.ready();
    // Every import a restart left, in batches until none are left.
    await batches(
      (after) => this.rows.unsettled(after),
      async (record) => {
        // Past the cutoff the result stands: finish setting it up instead of undoing it.
        if (record.result) {
          await this.complete(record, record.result);
          return;
        }
        await this.rollback(record);
        this.import(this.rows.get(record.transferId) ?? record);
      },
    );
    // Moved threads whose first turn a restart interrupted, every one of them.
    if (this.deps.live)
      for await (const start of this.deps.live.unfinished()) this.startLive(start.transferId);
    // Rows a cancel or failure settled before their rollback finished, every one of them.
    await batches(
      (after) => this.rows.leftovers(after),
      (record) => this.rollback(record),
    );
    // Files a crash left behind: removed only once their own transfer's row says it is settled
    // or gone, never by guess from a list that could be cut short.
    await removeStray(this.deps.directory, (name) => {
      const transferId = transferOfFile(name, incomingSuffixes);
      const record = transferId ? this.rows.get(transferId) : undefined;
      return record !== undefined && !settled.has(record.state);
    });
    await this.sweep();
  }
  /** Stops importing; a restart rolls back what an import made and runs it again. */
  async close(): Promise<void> {
    this.closed = true;
    this.deps.live?.close();
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
  /** A live move's final payload: what changed after the bulk, and the session (ADR 0191). */
  private finalFile(transferId: string) {
    return join(this.deps.directory, `${transferId}.final.part`);
  }
  private async removeFiles(transferId: string) {
    await removeQuietly(this.file(transferId));
    await removeQuietly(this.ignoredFile(transferId));
    await removeQuietly(this.finalFile(transferId));
    await rm(finalFolder(this.deps.directory, transferId), { recursive: true, force: true });
  }
  async view(record: IncomingRecord): Promise<IncomingTransfer> {
    const receiving = record.state === "receiving";
    const live =
      record.begin.live && this.deps.live ? this.deps.live.state(record.transferId) : undefined;
    // A moved thread is answered completed only once its first turn's start is known.
    const starting =
      record.commit?.live && record.state === "completed" && live?.running === undefined;
    return {
      transferId: record.transferId,
      state: starting ? "importing" : record.state,
      method: record.method,
      offset: receiving ? await fileBytes(this.file(record.transferId)) : 0,
      // Always present: this machine takes ignored files.
      ignoredOffset: receiving ? await fileBytes(this.ignoredFile(record.transferId)) : 0,
      ...(record.hasOrigin === undefined ? {} : { hasOrigin: record.hasOrigin }),
      ...(this.deps.identities ? { identity: true as const } : {}),
      ...(record.begin.live && this.deps.live
        ? {
            live: {
              finalOffset: receiving ? await fileBytes(this.finalFile(record.transferId)) : 0,
              ...(live?.running === undefined ? {} : { running: live.running }),
              ...(live ? { session: live.session } : {}),
            },
          }
        : {}),
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
    // A moved thread's transfer whose row retention dropped is answered from its receipt, so a
    // lost answer and a repeat never land it twice (ADR 0191).
    const receipt = this.rows.get(call.transferId)
      ? undefined
      : this.deps.live?.receipt(call.transferId, device.id);
    if (receipt) return receipt;
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
    if (call.live && !this.deps.live)
      throw new TargetRefusal("invalid", "This machine can't take a working thread.");
    if (call.remote) (this.deps.gitPolicy?.validateUrl ?? validateCloneUrl)(call.remote.url);
    const existing = this.rows.get(call.transferId);
    if (existing) return this.view(this.owned(device, call.transferId));
    await this.sweep();
    await ensureDirectory(this.deps.directory);
    const reused =
      call.method === "remote" && call.remote
        ? await this.sameOrigin(call.remote.normalized)
        : this.earlierCopy(device, call);
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
  /**
   * The project an earlier transfer of the same source project landed in, while it is still
   * registered here: sending a folder or a repository without a remote again lands in it.
   */
  private earlierCopy(device: Device, call: TransferBegin): WorkspaceId | undefined {
    if (!call.sourceWorkspaceId) return undefined;
    const source = this.landingSource(device.id, call);
    const id = source && this.rows.landedFor(source, call.method !== "archive");
    return this.deps.projects.list().find((project) => project.workspaceId === id)?.workspaceId;
  }
  private landingSource(deviceId: string, begin: TransferBegin) {
    if (!begin.sourceWorkspaceId) return undefined;
    return { hostId: begin.origin.hostId, workspaceId: begin.sourceWorkspaceId, deviceId };
  }
  /**
   * A registration here in the sender's logical project that the method can land in: for
   * `remote`, one whose origin is the source's; for a bundle, a repository; for an archive, a
   * plain folder. None that fits leaves the earlier rules (same origin, earlier copy) to choose.
   */
  private async identityLanding(
    record: IncomingRecord,
    identity: NonNullable<TransferCommit["identity"]>,
  ): Promise<WorkspaceId | undefined> {
    const holders = this.deps.identities?.holders(identity) ?? [];
    for (const holder of holders) {
      try {
        if (record.method === "remote") {
          const wanted = record.begin.remote?.normalized;
          const origin = await this.deps.git.transferOrigin(holder.path);
          if (wanted && origin?.normalized === wanted) return holder.workspaceId;
          continue;
        }
        const checkout = await this.deps.git.sourceCheckout(holder.path);
        // A bundle lands only at a repository's top, never in a folder inside another one.
        const fits =
          record.method === "bundle"
            ? checkout.kind === "checkout" && checkout.root === holder.path
            : checkout.kind === "folder";
        if (fits) return holder.workspaceId;
      } catch {
        /* One that can't be read is not a landing. */
      }
    }
    return undefined;
  }
  /**
   * A project here whose origin is the same repository: the most recently used of the first
   * `originBudget` registrations, read through a short-lived cache, so a begin answers well
   * within the sender's wait however many projects there are.
   */
  private sameOrigin(normalized: string): Promise<WorkspaceId | undefined> {
    return sameOriginProject(
      this.origins,
      this.deps.projects.list().slice(0, originBudget),
      normalized,
    );
  }
  /** One piece of the upload at `offset`; out of order answers what is held, unchanged. */
  async chunk(
    device: Device,
    transferId: string,
    offset: number,
    data: Buffer,
    part: "code" | "ignored" | "final" = "code",
  ) {
    const record = this.owned(device, transferId);
    if (data.length > transferChunkBytes) throw new TargetRefusal("invalid", "Chunk too large.");
    if (record.state !== "receiving")
      throw new TargetRefusal("invalid", "This transfer isn't receiving bytes.");
    if (this.closed) throw new TargetRefusal("unavailable", "This machine is shutting down.");
    const files = {
      code: this.file(transferId),
      ignored: this.ignoredFile(transferId),
      final: this.finalFile(transferId),
    };
    if (part === "final" && !record.begin.live)
      throw new TargetRefusal("invalid", "This transfer has no final payload.");
    const file = files[part];
    const others = Object.values(files).filter((path) => path !== file);
    const previous = this.writes.get(transferId) ?? Promise.resolve();
    // Serialised per transfer, so the cap counts both payloads as they stand before this write.
    const write = previous.then(async () => {
      const held = await fileBytes(file);
      let rest = 0;
      for (const path of others) rest += await fileBytes(path);
      if (held === offset && held + data.length + rest > maxTransferBytes)
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
    if (call.final) {
      const final = this.finalFile(call.transferId);
      const bytes = await fileBytes(final);
      if (bytes !== call.final.bytes)
        throw new TargetRefusal("invalid", `Holding ${bytes} of ${call.final.bytes} bytes.`);
      if ((await fileDigest(final)) !== call.final.sha256) {
        await this.removeFiles(call.transferId);
        this.settle(record.transferId, "failed", {
          code: "transfer_corrupt",
          message: "The file arrived damaged. Start the transfer again.",
        });
        return this.view(this.owned(device, call.transferId));
      }
    }
    // The sender's logical project lands in its registration here, where that fits the method.
    const byIdentity = call.identity
      ? await this.identityLanding(record, call.identity)
      : undefined;
    this.rows.update(
      call.transferId,
      { state: "importing", commit: call, ...(byIdentity ? { workspaceId: byIdentity } : {}) },
      this.deps.now(),
    );
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
    const commit = record.commit;
    const live = commit?.live && this.deps.live ? this.deps.live : undefined;
    const folder = finalFolder(this.deps.directory, record.transferId);
    try {
      if (live && commit?.final)
        await live.unpack(this.finalFile(record.transferId), folder, signal);
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
          ...(live && commit
            ? {
                delta: (path: string, held: { directoryFd: number } | undefined) =>
                  live.delta(folder, record.transferId, commit, path, held),
              }
            : {}),
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
          created: (result) => {
            this.rows.update(
              record.transferId,
              { result: { ...result, ...(ignored ? { ignoredSkipped } : {}) } },
              this.deps.now(),
            );
            // Past the cutoff, in the thread's own transaction: this machine owns it now.
            if (live && commit?.live && result.threadId)
              live.own({
                transferId: record.transferId,
                threadId: result.threadId,
                live: commit.live,
                from: { hostId: record.begin.origin.hostId, name: record.begin.origin.hostName },
              });
          },
        },
        record,
        hasFile ? file : undefined,
        signal,
      );
      await this.prepareLive(record, landed);
      this.finish(this.rows.get(record.transferId) ?? record, {
        ...landed,
        ...(ignored ? { ignoredSkipped } : {}),
      });
      await this.removeFiles(record.transferId);
      this.startLive(record.transferId);
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
    const setUp = async () => {
      await this.prepareLive(record, result);
      this.finish(this.rows.get(record.transferId) ?? record, result);
      await this.removeFiles(record.transferId);
      this.startLive(record.transferId);
    };
    try {
      await setUp();
    } catch (error) {
      this.deps.log("Transfer setup not finished", {
        transferId: record.transferId,
        error: String(error),
      });
      // Tried again without a restart; when it keeps failing the transfer still ends, so the
      // sender is answered and never waits on it (ADR 0191).
      void this.retrying(`setup:${record.transferId}`, setUp, (lastError) =>
        this.endWithoutSetup(record, result, lastError),
      );
    }
  }
  /** Retries `run` in the background, once per key at a time; see `persist`. */
  private retrying(
    key: string,
    run: () => Promise<void>,
    giveUp: (error: unknown) => Promise<void> | void,
  ): Promise<void> {
    if (this.retries.has(key)) return Promise.resolve();
    this.retries.add(key);
    return persist({
      attempts: 8,
      run,
      giveUp,
      sleep: this.deps.sleep ?? realSleep,
      closed: () => this.closed,
      log: this.deps.log,
      label: key,
    })
      .catch((error: unknown) => this.deps.log("Retry ended", { key, error: String(error) }))
      .finally(() => this.retries.delete(key));
  }
  /**
   * Past the cutoff the thread is this machine's, but its setup keeps failing: the transfer
   * completes without it, and a moved thread's start is recorded as not started, said on the
   * thread, so the sender moves on and the person sees why there.
   */
  private async endWithoutSetup(
    record: IncomingRecord,
    result: NonNullable<IncomingRecord["result"]>,
    error: unknown,
  ): Promise<void> {
    const reason = `the thread couldn't be set up here (${String(error).slice(0, 120)})`;
    this.rows.update(record.transferId, { state: "completed", result }, this.deps.now());
    if (record.commit?.live && result.threadId)
      this.deps.live?.giveUp({
        transferId: record.transferId,
        deviceId: record.deviceId,
        method: record.method,
        threadId: result.threadId,
        result,
        from: record.begin.origin.hostName,
        reason,
      });
    await this.removeFiles(record.transferId);
  }
  /**
   * A moved thread (ADR 0191): its carried session placed, or the summary chosen, before its
   * setup; the bulk's own capture ref removed. A restart repeats it with the same outcome.
   */
  private async prepareLive(record: IncomingRecord, landed: NonNullable<IncomingRecord["result"]>) {
    const live = this.deps.live;
    const carried = record.commit?.live;
    if (!live || !carried || !landed.threadId) return;
    await live.prepare({
      transferId: record.transferId,
      deviceId: record.deviceId,
      method: record.method,
      threadId: landed.threadId,
      result: landed,
      live: carried,
      folder: finalFolder(this.deps.directory, record.transferId),
    });
    await live.tidy(carried, landed.path);
  }
  /** Sends a moved thread's first turn and watches it start; the status answer waits for it. */
  private startLive(transferId: string): void {
    const record = this.rows.get(transferId);
    const live = this.deps.live;
    const commit = record?.commit;
    if (!record || !live || !commit?.live || !commit.thread || !record.result?.threadId) return;
    // Only a thread whose setup finished starts: its handoff and its link back are in place.
    // An unfinished setup starts it itself once done, or records why it never did.
    if (record.state !== "completed") return;
    const threadId = record.result.threadId;
    const result = record.result;
    const thread = commit.thread;
    const carried = commit.live;
    // Tried again without a restart; when it keeps failing the start is recorded as not
    // started, so the sender is answered and never waits on it (ADR 0191).
    void this.retrying(
      `start:${transferId}`,
      () =>
        live.start({
          transferId,
          live: carried,
          from: record.begin.origin.hostName,
          path: result.path,
          handoff: thread.handoff,
        }),
      (error) =>
        live.giveUp({
          transferId,
          deviceId: record.deviceId,
          method: record.method,
          threadId,
          result,
          from: record.begin.origin.hostName,
          reason: `its first turn couldn't be started here (${String(error).slice(0, 120)})`,
        }),
    );
  }
  /** Completes an import past its cutoff: the thread's setup and the row in one transaction. */
  private finish(record: IncomingRecord, landed: NonNullable<IncomingRecord["result"]>): void {
    const source = this.landingSource(record.deviceId, record.begin);
    const identity = record.commit?.identity;
    // Made by this landing: it takes the sender's identity; a reused one keeps any it has.
    const conflict =
      identity && this.deps.identities
        ? this.deps.identities.adopt(
            landed.workspaceId,
            identity,
            record.registeredId === landed.workspaceId,
          )
        : undefined;
    const result = conflict ? { ...landed, identityConflict: conflict } : landed;
    // The row and the record of where the project landed commit together.
    const complete = () =>
      this.deps.store.atomic(() => {
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
        if (source)
          this.rows.landedIn(
            source,
            { workspaceId: result.workspaceId, git: record.method !== "archive" },
            this.deps.now(),
          );
      });
    const thread = record.commit?.thread;
    if (thread && result.threadId)
      this.deps.threads.setUp(
        {
          threadId: result.threadId,
          // A carried session holds the whole conversation: no summary in front of it.
          handoff: this.deps.live?.state(record.transferId)?.session.kind !== "native",
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

/** Real time between retries; nothing waits on it at exit. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
