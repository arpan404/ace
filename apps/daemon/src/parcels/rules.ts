import { isAbsolute, normalize, sep } from "node:path";
import { parcelChunkBytes } from "@ace/protocol";

/**
 * Decisions about parcels (ADR 0182), with no I/O: what a receiver admits, what a sender sends
 * next, when it tries again and who may send to whom. The paths it tries are `machines/link-routes.ts`.
 */

/** Why a receiver refuses a chunk; each is final for that chunk, never for the parcel. */
export type ChunkRefusal = "offset" | "overrun" | "unknown";

/**
 * Whether a chunk at `offset` may be appended to a parcel of `size` bytes whose receiver holds
 * `held` bytes durably. Only the next bytes are taken, so a chunk sent twice (its answer was
 * lost) or out of order never writes anything; the sender reads `held` from the answer and goes
 * on from there.
 */
export function admitChunk(
  facts: { size: number; held: number },
  offset: number,
  length: number,
): { ok: true } | { ok: false; refusal: ChunkRefusal } {
  if (offset !== facts.held) return { ok: false, refusal: "offset" };
  if (length === 0 || length > parcelChunkBytes || offset + length > facts.size)
    return { ok: false, refusal: "overrun" };
  return { ok: true };
}

/**
 * What a receiver holds after a restart: the bytes on disk, never more than it recorded nor the
 * parcel's size. A write that didn't finish before a crash is sent again.
 */
export function heldAfterRestart(onDisk: number, recorded: number, size: number): number {
  return Math.max(0, Math.min(onDisk, recorded, size));
}

/** The next range to send or read, or undefined when every byte is there. */
export function nextRange(
  held: number,
  size: number,
): { offset: number; length: number } | undefined {
  if (held >= size) return undefined;
  return { offset: held, length: Math.min(parcelChunkBytes, size - held) };
}

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 60_000;
/** A parcel that hasn't reached its machine within this long fails; the sender is told. */
export const PARCEL_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** How long to wait before attempt `attempt` (1 is the first retry): doubling, capped. */
export function retryDelay(attempt: number): number {
  return Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, Math.min(attempt - 1, 16)));
}

/** What the sender knows of a local thread, to decide who may receive from it. */
export interface TreeThread {
  id: string;
  /** The local thread whose agent delegated it. */
  delegatedBy?: string | undefined;
  deleted: boolean;
}

/** Walk at most this many parents: deeper trees are refused rather than walked further. */
const MAX_DEPTH = 32;

function rootOf(id: string, thread: (id: string) => TreeThread | undefined): string | undefined {
  let at = thread(id);
  for (let depth = 0; at && depth < MAX_DEPTH; depth++) {
    if (!at.delegatedBy) return at.id;
    at = thread(at.delegatedBy);
  }
  return undefined;
}

/**
 * Whether a thread may send a parcel to another thread on this machine: both live and in the
 * same agent tree (one root through `delegatedBy`). Agents in different trees, which belong to
 * different tasks of the person's, never exchange data on their own.
 */
export function mayDeliverLocally(
  from: string,
  to: string,
  thread: (id: string) => TreeThread | undefined,
): boolean {
  if (from === to) return false;
  const sender = thread(from);
  const receiver = thread(to);
  if (!sender || !receiver || sender.deleted || receiver.deleted) return false;
  const root = rootOf(from, thread);
  return root !== undefined && root === rootOf(to, thread);
}

/**
 * A relative path inside a project for `saveAs`, or undefined when it would leave the project,
 * name its root, or enter `.git`. The caller still opens it without following links.
 */
export function projectRelative(saveAs: string): string | undefined {
  if (isAbsolute(saveAs) || saveAs.includes("\0")) return undefined;
  const clean = normalize(saveAs);
  if (clean === "." || clean.startsWith("..")) return undefined;
  const parts = clean.split(sep);
  // `.git` in any case: macOS and Windows disks usually don't tell `.GIT` from `.git`.
  if (parts.some((part) => part === ".." || part.toLowerCase() === ".git" || part === ""))
    return undefined;
  return clean;
}

/** A size as a person reads it. */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
