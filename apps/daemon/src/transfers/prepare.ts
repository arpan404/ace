import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { GitError, validateCloneUrl, type ProjectGitPolicy } from "@ace/git";
import { maxTransferBytes, type TransferMethod } from "@ace/protocol";
import { archivePrune, ignoredInProject } from "./archive-selection.ts";
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

/** Where the folder sits for Git, with any refusal in words a person acts on (ADR 0101). */
async function sourceCheckout(git: TransferGit, source: string) {
  let found: Awaited<ReturnType<TransferGit["sourceCheckout"]>>;
  try {
    found = await git.sourceCheckout(source);
  } catch (error) {
    if (error instanceof GitError && error.code === "git_missing")
      throw new TransferError(
        "git_missing",
        "This project is a Git repository, but Git isn't installed on this machine. Install Git, then try again.",
      );
    throw new TransferError(
      "source_unreadable",
      "Git couldn't read this project's repository. Run git status in its folder to see why, then try again.",
    );
  }
  if (found.kind === "untrusted")
    throw new TransferError(
      "source_untrusted",
      "Git won't read this project's repository because its folder belongs to another user. Mark it safe with git config --global --add safe.directory and the folder's path, then try again.",
    );
  return found;
}

/**
 * How the code travels (ADR 0101): a repository's top with an origin goes as `remote`, one
 * without as `bundle`. Any other folder goes as `archive`: a plain folder, a folder inside a
 * repository (so only that folder lands, not the whole repository), and a repository with no
 * commit and no changes to carry (its bundle would hold nothing). Uncommitted changes are
 * captured as a commit without touching the checkout or its index.
 */
export async function planSource(
  git: TransferGit,
  input: { transferId: string; source: string; name: string; includeChanges: boolean },
  policy: ProjectGitPolicy = {},
): Promise<{ method: TransferMethod; plan: TransferPlan }> {
  const base = { source: input.source, name: input.name };
  const checkout = await sourceCheckout(git, input.source);
  if (checkout.kind === "folder") return { method: "archive", plan: base };
  const folder = relative(checkout.root, await realpath(input.source))
    .split(sep)
    .join("/");
  const archived = {
    method: "archive" as const,
    plan: { ...base, repository: { root: checkout.root, path: folder } },
  };
  if (folder) return archived;
  const refs = await git.bundleRefs(input.source);
  if (!refs.head && !input.includeChanges) return archived;
  const remote = await git.transferOrigin(input.source);
  if (remote) (policy.validateUrl ?? validateCloneUrl)(remote.url);
  const changes = input.includeChanges
    ? await git.captureChanges(input.source, {
        ref: changesRef(input.transferId),
        message: "Uncommitted changes carried to another machine",
      })
    : undefined;
  if (!refs.head && !changes) return archived;
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

/** What an archive of `plan.source` leaves behind; see `archive-selection.ts`. */
async function archiveRule(git: TransferGit, plan: TransferPlan, includeIgnored: boolean) {
  const { repository } = plan;
  if (!repository) return archivePrune({ includeIgnored });
  let ignored: string[];
  try {
    ignored = await git.ignoredPaths(repository.root, repository.path || undefined);
  } catch {
    throw new TransferError(
      "ignored_unreadable",
      "Git couldn't list the files it ignores in this folder, so nothing was sent. Try again.",
    );
  }
  const inProject = ignoredInProject(ignored, repository.path);
  return archivePrune({
    includeIgnored,
    ...(inProject ? { checkout: { ignored: inProject } } : {}),
  });
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
    /** For an archive: whether files Git ignores, or a plain folder's `.env`, go too. */
    includeIgnored: boolean;
    signal: AbortSignal;
  },
): Promise<TransferPlan["file"]> {
  const { plan, file, signal } = input;
  await removeQuietly(file);
  if (input.method === "archive") {
    const prune = await archiveRule(deps.git, plan, input.includeIgnored);
    const measured = await deps.archive.measureFolder(plan.source, { signal, prune });
    if (measured.bytes > maxTransferBytes) throw tooLarge(measured.bytes);
    const packed = await deps.archive.packFolder(plan.source, file, {
      signal,
      prune,
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
