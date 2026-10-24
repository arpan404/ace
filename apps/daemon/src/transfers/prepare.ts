import { maxTransferBytes, type TransferMethod } from "@ace/protocol";
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

function tooLarge(bytes: number): TransferError {
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
 * How the code travels (ADR 0099): a Git repository with an origin goes as `remote`, one without
 * as `bundle`, any other folder as `archive`. Uncommitted changes are captured as a commit
 * without touching the checkout or its index.
 */
export async function planSource(
  git: TransferGit,
  input: { transferId: string; source: string; name: string; includeChanges: boolean },
): Promise<{ method: TransferMethod; plan: TransferPlan }> {
  const base = { source: input.source, name: input.name };
  let refs: Awaited<ReturnType<TransferGit["bundleRefs"]>>;
  try {
    refs = await git.bundleRefs(input.source);
  } catch {
    return { method: "archive", plan: base };
  }
  const remote = await git.transferOrigin(input.source).catch(() => undefined);
  const changes = input.includeChanges
    ? await git.captureChanges(input.source, {
        ref: changesRef(input.transferId),
        message: "Uncommitted changes carried to another machine",
      })
    : undefined;
  return {
    method: remote ? "remote" : "bundle",
    plan: {
      ...base,
      ...(remote ? { remote } : {}),
      ...(refs.branch ? { branch: refs.branch } : {}),
      ...(refs.head ? { head: refs.head } : {}),
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
      ];
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
