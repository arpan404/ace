import { leaseOwner, queryLeaseOwner } from "./lease-owner.ts";
import { within } from "./repository-paths.ts";
import { leaseState } from "./mutation-state.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CleanupResult, MutationLease, type CleanupReceipt } from "@ace/provider-kit/cleanup";
import { GitError } from "./types.ts";

interface OwnedLease {
  record: MutationLease;
  file: string;
  quarantined: boolean;
  cleanups: Promise<CleanupResult>[];
  released: Promise<void>;
  release(): void;
}
// These are process-local I/O ownership registries, shared across service instances.
const scope = new AsyncLocalStorage<readonly OwnedLease[]>();
const live = new Map<string, OwnedLease>();

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
const metadataLimit = 1_100_000;
async function text(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size > metadataLimit)
      throw new GitError("git_quarantined", "Git ownership metadata exceeds limit");
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > size)
      throw new GitError("git_quarantined", "Git ownership metadata changed while reading");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Node cannot flush directory handles on Windows. File contents are flushed;
    // surviving intents still fail closed after process/daemon restart.
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EPERM", "EISDIR", "EINVAL"].includes(String(error.code))
    )
      return;
    throw error;
  }
}

/** Resolve .git files and linked-worktree common directories without launching Git. */
async function journal(root: string): Promise<string | undefined> {
  const dot = join(root, ".git");
  let metadata: string;
  try {
    const info = await lstat(dot);
    if (info.isDirectory()) metadata = dot;
    else if (info.isFile()) {
      const contents = await text(dot);
      const match =
        contents && !contents.includes("\0")
          ? /^gitdir: ([\s\S]+)$/.exec(contents.replace(/\n$/, ""))
          : null;
      if (!match?.[1]) throw new GitError("git_quarantined", "Invalid Git ownership directory");
      metadata = resolve(root, match[1]);
    } else throw new GitError("git_quarantined", "Unsafe Git ownership directory");
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  const common = await text(join(metadata, "commondir"));
  if (common) metadata = resolve(metadata, common.replace(/\n$/, ""));
  return join(await realpath(metadata), "ace-mutation-leases");
}

async function scopeJournal(root: string): Promise<string> {
  // A new repository owns its destination, even when created inside another repository.
  return (await journal(root)) ?? standaloneJournal(root);
}
function standaloneJournal(root: string): string {
  return join(
    dirname(root),
    ".ace-git-mutation-leases",
    createHash("sha256").update(root).digest("hex"),
  );
}
async function journals(path: string): Promise<string[]> {
  const result = new Set<string>();
  let root = await realpath(path);
  for (;;) {
    const directory = await journal(root);
    if (directory) result.add(directory);
    result.add(standaloneJournal(root));
    const parent = dirname(root);
    if (parent === root) return [...result];
    root = parent;
  }
}

async function records(path: string): Promise<{ record: MutationLease; file: string }[]> {
  const result: { record: MutationLease; file: string }[] = [];
  for (const directory of await journals(path)) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (names.length > 256)
      throw new GitError("git_quarantined", "Git ownership journal exceeds limit");
    for (const name of names) {
      const file = join(directory, name);
      if (name.endsWith(".next")) continue;
      const running = live.get(name);
      if (running) {
        result.push({ record: running.record, file });
        continue;
      }
      const content = await text(file);
      if (content === undefined) continue;
      try {
        const record = MutationLease.parse(JSON.parse(content));
        if (name !== record.id) throw new Error("lease identity mismatch");
        result.push({ record, file });
      } catch {
        throw new GitError("git_quarantined", "Invalid Git ownership journal", { file });
      }
    }
  }
  return result;
}

export async function mutationState(path: string, schedule = scheduleProbe) {
  const discovered = await records(path);
  const known = new Map<string, { quarantined: boolean }>(live);
  const root = await realpath(path);
  const retained: MutationLease[] = [];
  for (const { record, file } of discovered) {
    if (!known.has(record.id)) {
      const state = await queryLeaseOwner(record, schedule);
      if (state === "active" && !within(record.root, root) && !within(root, record.root))
        known.set(record.id, { quarantined: false });
      else if ((await text(file)) === undefined) continue; // Successful concurrent retirement.
    }
    retained.push(record);
  }
  return leaseState(retained, known);
}
export async function assertAvailable(path: string, schedule = scheduleProbe): Promise<void> {
  let state;
  try {
    state = await mutationState(path, schedule);
  } catch (error) {
    if (missing(error))
      throw new GitError("not_a_repo", `Git working directory no longer exists: ${path}`);
    throw error;
  }
  if (state.status === "quarantined")
    throw new GitError("git_quarantined", "Repository cleanup is unconfirmed", {
      leases: state.leases,
    });
}

export async function withMutationLease<T>(
  root: string,
  id: () => string,
  operation: () => Promise<T>,
  schedule = scheduleProbe,
): Promise<T> {
  await assertAvailable(root, schedule);
  const directory = await scopeJournal(root);
  const endpoint = await leaseOwner(id, (identity) => {
    const owned = live.get(identity);
    return owned ? (owned.quarantined ? "quarantined" : "active") : "unknown";
  });
  const record = MutationLease.parse({
    version: 1,
    id: id(),
    root,
    roots: [root],
    owner: endpoint,
  });
  const file = join(directory, record.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const owned: OwnedLease = { record, file, quarantined: false, cleanups: [], released, release };
  // The intent reaches disk before any process can mutate this root. A crash leaves
  // an unknown identity, which a restarted daemon treats as quarantined.
  const ancestors = scope.getStore() ?? [];
  for (const ancestor of ancestors) {
    ancestor.record = MutationLease.parse({
      ...ancestor.record,
      roots: [...new Set([...ancestor.record.roots, root])],
    });
    const update = await open(ancestor.file + ".next", "w", 0o600);
    try {
      await update.writeFile(JSON.stringify(ancestor.record));
      await update.sync();
    } finally {
      await update.close();
    }
    await rename(ancestor.file + ".next", ancestor.file);
    await syncDirectory(dirname(ancestor.file));
  }
  if (live.has(record.id)) throw new GitError("git_busy", "Mutation lease identity already active");
  live.set(record.id, owned);
  let created = false;
  try {
    const handle = await open(file, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    return await scope.run([...(scope.getStore() ?? []), owned], operation);
  } finally {
    release();
    try {
      if (created && !owned.quarantined) await rm(file, { force: true });
    } finally {
      live.delete(record.id);
    }
  }
}

export function captureMutationOwnership() {
  const held = scope.getStore() ?? [];
  return {
    leases: held.map(({ record }) => record),
    quarantine: (receipt: CleanupReceipt) => quarantine(receipt, held),
  };
}

/** Synchronously deny access before rejecting the caller. Disk intents already exist. */
function quarantine(receipt: CleanupReceipt, held: readonly OwnedLease[]): Promise<CleanupResult> {
  const result = receipt.settled
    .then((raw) => CleanupResult.parse(raw))
    .catch((): CleanupResult => ({
      status: "unconfirmed",
      reason: "Cleanup supervisor failed",
    }));
  for (const owned of held) {
    owned.quarantined = true;
    owned.cleanups.push(result);
  }
  return result.then(async (outcome): Promise<CleanupResult> => {
    if (outcome.status !== "confirmed") return outcome;
    await Promise.all(held.map((owned) => owned.released));
    const outcomes = await Promise.all(held.flatMap((owned) => owned.cleanups));
    if (outcomes.some((value) => value.status !== "confirmed"))
      return { status: "unconfirmed", reason: "Other owned processes have unconfirmed cleanup" };
    try {
      await Promise.all(held.map((owned) => rm(owned.file, { force: true })));
    } catch {
      return { status: "unconfirmed", reason: "Cannot retire durable mutation leases" };
    }
    return outcome;
  });
}

export async function recoverMutationLeases(
  path: string,
  recover: (lease: MutationLease) => Promise<CleanupResult>,
  schedule = scheduleProbe,
) {
  const discovered = await records(path);
  const seen = new Set(discovered.map(({ record }) => record.id));
  for (let index = 0; index < discovered.length; index++) {
    for (const root of discovered[index]?.record.roots ?? []) {
      for (const entry of await records(root)) {
        if (seen.has(entry.record.id)) continue;
        seen.add(entry.record.id);
        discovered.push(entry);
      }
    }
  }
  if (discovered.some(({ record }) => live.has(record.id))) return mutationState(path, schedule);
  for (const { record } of discovered) {
    if ((await queryLeaseOwner(record, schedule)) === "active")
      return mutationState(path, schedule);
  }
  const outcomes: CleanupResult[] = [];
  for (const { record } of discovered) {
    try {
      outcomes.push(CleanupResult.parse(await recover(record)));
    } catch {
      outcomes.push({ status: "unconfirmed", reason: "Cleanup supervisor failed" });
    }
  }
  // A parent must stay fenced until every captured descendant is confirmed.
  if (outcomes.every((result) => result.status === "confirmed"))
    await Promise.all(discovered.map(({ file }) => rm(file, { force: true })));
  return mutationState(path, schedule);
}

export const mutationLeaseId = randomUUID;

export function scheduleProbe(callback: () => void, milliseconds: number): () => void {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
}
