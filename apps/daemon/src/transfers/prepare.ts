import { validateCloneUrl, type ProjectGitPolicy } from "@ace/git";
import { maxTransferBytes, type TransferMethod } from "@ace/protocol";
import { ignoredSelection, staysBehind } from "./ignored-files.ts";
import { headRef } from "./landing.ts";
import type { TransferPlan } from "./outgoing-rows.ts";
import { fileDigest, removeQuietly } from "./files.ts";
import { TransferError, type TransferArchive, type TransferGit } from "./ports.ts";

/** "1.2 GB", for the size refusal a person reads. */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

export function tooLarge(bytes: number): TransferError {
  return new TransferError(
    "transfer_too_large",
    `This is ${formatBytes(bytes)}; a transfer can carry at most ${formatBytes(maxTransferBytes)}.`,
  );
}

const fullRef = (prefix: string, name: string) =>
  name.startsWith("refs/") ? name : `${prefix}${name}`;

/** The ref uncommitted changes travel under, in the bundle and briefly in the source repo. */
export const changesRef = (transferId: string) => `refs/ace/transfer/${transferId}`;

/**
 * How the code travels (ADR 0101): a Git repository with an origin goes as `remote`, one without
 * as `bundle`, any other folder as `archive`. Uncommitted changes are captured as a commit
 * without touching the checkout or its index.
 */
export async function planSource(
  git: TransferGit,
  input: { transferId: string; source: string; name: string; includeChanges: boolean },
  policy: ProjectGitPolicy = {},
): Promise<{ method: TransferMethod; plan: TransferPlan }> {
  const base = { source: input.source, name: input.name };
  let refs: Awaited<ReturnType<TransferGit["bundleRefs"]>>;
  try {
    refs = await git.bundleRefs(input.source);
  } catch {
    return { method: "archive", plan: base };
  }
  const remote = await git.transferOrigin(input.source);
  if (remote) (policy.validateUrl ?? validateCloneUrl)(remote.url);
  const changes = input.includeChanges
    ? await git.captureChanges(input.source, {
        ref: changesRef(input.transferId),
        message: "Uncommitted changes carried to another machine",
      })
    : undefined;
  // A detached HEAD has no branch to carry it: a ref pins the commit so the bundle holds it.
  const pinned = !refs.branch && refs.head ? headRef(input.transferId) : undefined;
  if (pinned && refs.head) await git.pinRef(input.source, pinned, refs.head);
  return {
    method: remote ? "remote" : "bundle",
    plan: {
      ...base,
      ...(remote ? { remote } : {}),
      ...(refs.branch ? { branch: refs.branch } : {}),
      ...(refs.head ? { head: refs.head } : {}),
      ...(pinned ? { pinned } : {}),
      ...(changes
        ? { changes: { ref: changesRef(input.transferId), commit: changes.commit } }
        : {}),
    },
  };
}

/**
 * Writes what travels to `file`: a full or incremental bundle, or the folder's archive. None when
 * an incremental bundle would be empty because origin already has everything.
 */
export async function writeTransferFile(
  deps: { git: TransferGit; archive: TransferArchive },
  input: {
    method: TransferMethod;
    plan: TransferPlan;
    file: string;
    incremental: boolean;
    signal: AbortSignal;
  },
): Promise<TransferPlan["file"]> {
  const { plan, file, signal } = input;
  await removeQuietly(file);
  if (input.method === "archive") {
    const measured = await deps.archive.measureFolder(plan.source, { signal });
    if (measured.bytes > maxTransferBytes) throw tooLarge(measured.bytes);
    const packed = await deps.archive.packFolder(plan.source, file, {
      signal,
      maxBytes: maxTransferBytes,
    });
    return { path: file, bytes: packed.bytes, sha256: packed.sha256 };
  }
  const refs = await deps.git.bundleRefs(plan.source);
  const wanted = input.incremental
    ? plan.branch
      ? [fullRef("refs/heads/", plan.branch)]
      : []
    : [
        ...refs.branches.map((name) => fullRef("refs/heads/", name)),
        ...refs.tags.map((name) => fullRef("refs/tags/", name)),
        // Keep the sender's last-known origin branches, without asking origin for anything.
        ...(plan.remote ? refs.originTracking : []),
      ];
  if (plan.pinned) wanted.push(plan.pinned);
  if (plan.changes) wanted.push(plan.changes.ref);
  if (!wanted.length) return undefined;
  const written = await deps.git.createBundle(plan.source, {
    file,
    refs: wanted,
    ...(input.incremental ? { exclude: refs.originTracking } : {}),
  });
  if ("empty" in written) return undefined;
  if (written.bytes > maxTransferBytes) {
    await removeQuietly(file);
    throw tooLarge(written.bytes);
  }
  return { path: file, bytes: written.bytes, sha256: await fileDigest(file, signal) };
}

/**
 * Packs the files Git ignores in `source` into `file` (mode 0600), leaving dependency and cache
 * folders and nested repositories behind. None when nothing would travel. `room` is what the
 * 20 GiB cap leaves after the code. Failures name no file: the names may be secret.
 */
export async function writeIgnoredFile(
  deps: { git: TransferGit; archive: TransferArchive },
  input: { source: string; file: string; room: number; signal: AbortSignal },
): Promise<{ path: string; bytes: number; sha256: string; files: number } | undefined> {
  const { file, signal } = input;
  await removeQuietly(file);
  let packed: Awaited<ReturnType<TransferArchive["packFiles"]>>;
  try {
    const selection = ignoredSelection(await deps.git.ignoredPaths(input.source));
    if (!selection.length) return undefined;
    packed = await deps.archive.packFiles(input.source, selection, file, {
      signal,
      prune: staysBehind,
      maxBytes: input.room,
    });
  } catch (error) {
    await removeQuietly(file);
    if (signal.aborted) throw error;
    if (error instanceof Error && "code" in error && error.code === "TOO_LARGE")
      throw new TransferError(
        "transfer_too_large",
        `The code and the files Git ignores come to more than ${formatBytes(maxTransferBytes)}, the most a transfer carries. Turn off Bring ignored files and try again.`,
      );
    throw new TransferError(
      "ignored_unreadable",
      "The files Git ignores couldn't be read. Turn off Bring ignored files, or try again.",
    );
  }
  if (!packed.files) {
    await removeQuietly(file);
    return undefined;
  }
  return { path: file, bytes: packed.bytes, sha256: packed.sha256, files: packed.files };
}
